// DATA-LOCALITY BOUNDARY (ONLY_ATTESTATIONS_LEAVE). Embedding input IS user
// content — the answer texts of the quorum. A cloud embedding call therefore
// egresses content exactly like a prompt call, and must be refused when the
// boundary is engaged and the endpoint is not the operator's own box. This is
// the #380 "embedding leak" TODO: the assertion below throws before any cloud
// embedding fetch, just like the prompt path in cross-llm-client.queryProvider.
import { assertPromptEgressAllowed } from '../../../selfhost/egress-guard';

export interface EmbeddingClient {
    embed(text: string): Promise<number[]>;
    embedMany(texts: string[]): Promise<number[][]>;
}

export class XenovaEmbeddingClient implements EmbeddingClient {
    private pipelinePromise: Promise<any> | null = null;
    
    private async getPipeline() {
        if (!this.pipelinePromise) {
            const { pipeline, env } = await import('@xenova/transformers');
            env.allowLocalModels = true; 
            this.pipelinePromise = pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
        }
        return this.pipelinePromise;
    }

    async embed(text: string): Promise<number[]> {
        const pipe = await this.getPipeline();
        const output = await pipe(text, { pooling: 'mean', normalize: true });
        return Array.from(output.data);
    }

    async embedMany(texts: string[]): Promise<number[][]> {
        const pipe = await this.getPipeline();
        const output = await pipe(texts, { pooling: 'mean', normalize: true });
        const results: number[][] = [];
        const dim = output.dims[1];
        for (let i = 0; i < texts.length; i++) {
            const row = Array.from(output.data.subarray(i * dim, (i + 1) * dim)) as number[];
            results.push(row);
        }
        return results;
    }
}

/** Default per-request embedding timeout. A hung provider must not stall the quorum. */
export const DEFAULT_EMBEDDING_TIMEOUT_MS = 15_000;

export class OpenAIEmbeddingClient implements EmbeddingClient {
    constructor(
        private endpoint: string,
        private apiKey: string,
        private model: string = 'text-embedding-3-small',
        private timeoutMs: number = DEFAULT_EMBEDDING_TIMEOUT_MS,
    ) {}

    async embed(text: string): Promise<number[]> {
        const res = await this.embedMany([text]);
        return res[0]!;
    }

    async embedMany(texts: string[]): Promise<number[][]> {
        // DATA-LOCALITY: refuse to send content to a non-local embedder when
        // ONLY_ATTESTATIONS_LEAVE is engaged. A local endpoint (LOCAL_LLM_BASE_URL
        // pointed at Ollama/vLLM) passes; api.openai.com throws. Caught upstream
        // (FallbackEmbeddingClient / computeAgreement) → honest degrade, never a
        // silent cloud call.
        assertPromptEgressAllowed(this.endpoint, 'embedding');
        // A missing timeout is how a single unresponsive provider hangs the whole
        // semantic-similarity layer. On timeout, fetch rejects and the caller
        // (FallbackEmbeddingClient) degrades to the local model — never an infinite wait.
        const res = await fetch(this.endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`
            },
            body: JSON.stringify({ model: this.model, input: texts }),
            signal: AbortSignal.timeout(this.timeoutMs)
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`embedding ${res.status}: ${body}`);
        }
        const data: any = await res.json();
        if (!data?.data || !Array.isArray(data.data)) throw new Error('Invalid embedding format');
        return data.data.map((item: any) => item.embedding);
    }
}

export class VoyageEmbeddingClient implements EmbeddingClient {
    constructor(
        private apiKey: string,
        private model: string = 'voyage-3',
        private timeoutMs: number = DEFAULT_EMBEDDING_TIMEOUT_MS,
    ) {}

    async embed(text: string): Promise<number[]> {
        const res = await this.embedMany([text]);
        return res[0]!;
    }

    async embedMany(texts: string[]): Promise<number[][]> {
        // DATA-LOCALITY: Voyage is always a cloud host — refuse under the boundary.
        assertPromptEgressAllowed('https://api.voyageai.com/v1/embeddings', 'embedding');
        const res = await fetch('https://api.voyageai.com/v1/embeddings', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`
            },
            body: JSON.stringify({ model: this.model, input: texts }),
            signal: AbortSignal.timeout(this.timeoutMs)
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`Voyage embedding ${res.status}: ${body}`);
        }
        const data: any = await res.json();
        if (!data?.data || !Array.isArray(data.data)) throw new Error('Invalid embedding format');
        return data.data.map((item: any) => item.embedding);
    }
}

export class FallbackEmbeddingClient implements EmbeddingClient {
    private localClient = new XenovaEmbeddingClient();
    
    constructor(private remoteClient: EmbeddingClient | null) {}
    
    async embed(text: string): Promise<number[]> {
        return this.embedMany([text]).then(res => res[0]!);
    }

    async embedMany(texts: string[]): Promise<number[][]> {
        let lastError: any = null;
        if (this.remoteClient) {
            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    return await this.remoteClient.embedMany(texts);
                } catch (e: any) {
                    lastError = e;
                    if (e.message.includes('429')) {
                        console.warn(`[EmbeddingClient] Attempt ${attempt} failed with 429. Backing off...`);
                        await new Promise(r => setTimeout(r, attempt * 1000));
                        continue;
                    }
                    break;
                }
            }
        }
        
        console.warn(`[EmbeddingClient] Remote failed or not configured. Falling back to local Xenova... (${lastError?.message || 'No remote client'})`);
        return this.localClient.embedMany(texts);
    }
}

export function createDefaultEmbeddingClient(apiKey?: string, endpoint?: string): EmbeddingClient {
    let remote: EmbeddingClient | null = null;
    if (apiKey) {
        if (endpoint && endpoint.includes('openai')) {
            remote = new OpenAIEmbeddingClient(endpoint, apiKey);
        } else if (endpoint && endpoint.includes('voyage')) {
            remote = new VoyageEmbeddingClient(apiKey);
        } else {
            // Default to Voyage if no endpoint specified but we have a key
            remote = new VoyageEmbeddingClient(apiKey);
        }
    }
    return new FallbackEmbeddingClient(remote);
}
