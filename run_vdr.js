"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const index_1 = __importDefault(require("./src/index"));
const http = __importStar(require("http"));
const URL = 'http://127.0.0.1:3001/api/v1';
async function run() {
    const server = http.createServer(index_1.default);
    server.listen(3001, "127.0.0.1", async () => {
        console.log("Server listening on 3001 for VDR seeding...");
        const agents = [];
        const providers = ['OpenAI', 'Anthropic', 'Google'];
        for (let i = 0; i < 3; i++) {
            const res = await fetch(`${URL}/agents/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    agent_name: `Test_Agent_VDR_${i}`,
                    llm_provider: providers[i],
                    is_human: false
                })
            });
            const data = await res.json();
            if (data.agent_id) {
                agents.push({ id: data.agent_id, key: data.api_key, provider: providers[i] });
            }
            else {
                console.log("Failed to register agent", data);
            }
        }
        if (agents.length === 0) {
            console.log("Failed to register and no agents available.");
            server.close();
            return process.exit(1);
        }
        console.log(`Registered agents: ${agents.map(a => a.id).join(', ')}`);
        let totalVdr = 0;
        let eventsSent = 0;
        while (totalVdr < 100 && eventsSent < 110) {
            for (const agent of agents) {
                if (totalVdr >= 100)
                    break;
                eventsSent++;
                const reqBody = {
                    llm_provider: agent.provider,
                    llm_model: agent.provider === 'OpenAI' ? 'gpt-4' : 'claude-3',
                    certainty: 0.8 + (Math.random() * 0.1),
                    decision_text: `Decision test ${Date.now()}_${Math.random()}`,
                    outcome: 'PENDING',
                    task_domain: 'finance',
                    hallucination_caught: Math.random() > 0.95
                };
                const res = await fetch(`${URL}/agents/${agent.id}/score-event`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${agent.key}`
                    },
                    body: JSON.stringify(reqBody)
                });
                if (!res.ok) {
                    console.log("Error posting score:", await res.text(), "Code:", res.status);
                    await new Promise(r => setTimeout(r, 1000));
                    continue;
                }
                const data = await res.json();
                if (data.vdr_count) {
                    totalVdr = data.vdr_count;
                }
            }
        }
        console.log(`Generated enough events! Latest agent VDR: ${totalVdr}. Sent ${eventsSent} requests.`);
        // Display leaderboard
        const board = await fetch(`${URL}/llm-trust`);
        console.log("=== LLM TRUST LEADERBOARD ===");
        console.log(JSON.stringify(await board.json(), null, 2));
        server.close();
        process.exit(0);
    });
}
run().catch(console.error);
//# sourceMappingURL=run_vdr.js.map