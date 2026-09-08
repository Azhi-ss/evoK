declare module "*.json" {
  const value: Record<string, unknown>;
  export default value;
}

declare module "bun:test" {
  export function describe(name: string, callback: () => void): void;
  export function test(name: string, callback: () => void | Promise<void>, timeout?: number): void;
  export namespace test {
    function skip(name: string, callback: () => void | Promise<void>): void;
  }
  export function afterEach(callback: () => void): void;
  export const expect: {
    <T>(actual: T): any;
    arrayContaining(values: unknown[]): unknown;
  };
}
