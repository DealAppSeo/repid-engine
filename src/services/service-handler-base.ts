import type { ServiceContractRow } from '../types';

export abstract class ServiceHandlerBase {
  protected abstract readonly serviceType: string;

  public async process(contract: ServiceContractRow): Promise<void> {
    await this.fulfill(contract);
  }

  protected abstract fulfill(contract: ServiceContractRow): Promise<Record<string, unknown>>;
}
