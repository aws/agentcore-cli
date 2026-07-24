import {
  DEFAULT_GLOBAL_CONFIG,
  type GlobalConfig,
  type GlobalConfigAccessor,
} from "../globalConfig";

type TestGlobalConfigAccessorOptions = {
  initialConfigData?: GlobalConfig;
};

/**
 * In-memory GlobalConfigAccessor for tests.
 */
export class TestGlobalConfigAccessor implements GlobalConfigAccessor {
  private configData: GlobalConfig;

  constructor(options?: TestGlobalConfigAccessorOptions) {
    this.configData = options?.initialConfigData ?? DEFAULT_GLOBAL_CONFIG;
  }

  public async get(): Promise<GlobalConfig> {
    return this.configData;
  }

  public async set(newConfig: GlobalConfig): Promise<GlobalConfig> {
    this.configData = newConfig;
    return this.configData;
  }
}
