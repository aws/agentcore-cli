export interface AttributeRecorder<T extends Record<string, unknown>> {
  set<K extends keyof T>(attrs: Pick<T, K>): void;
  get(): Partial<T>;
}

export function createAttributeRecorder<T extends Record<string, unknown>>(): AttributeRecorder<T> {
  let recorded: Partial<T> = {};
  return {
    set<K extends keyof T>(attrs: Pick<T, K>) {
      recorded = { ...recorded, ...attrs };
    },
    get() {
      return recorded;
    },
  };
}
