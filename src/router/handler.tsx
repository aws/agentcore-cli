import type z from "zod";
import type { Context, ContextKey } from "./context";

// Flag is generic over its literal name `N` and its inferred value type `T`, so a
// tuple of flags can be mapped to a typed object at the authoring boundary (see
// FlagsOf / createHandler). The runtime tree only ever sees the erased
// Flag<string, unknown>.
export interface Flag<N extends string = string, T = unknown> {
  name: N;
  description: string;
  schema: z.ZodType<T>;
  // help is optional long-form documentation rendered in the command's
  // "Parameter details" help section (see flags.tsx/formatParameterDetails).
  // Its first line is the type annotation shown next to the flag name; the
  // remaining lines are the body — prose, JSON syntax, examples.
  help?: string;
}

// GlobalFlag is a group-level flag that is *also* a typed ContextKey: declared on
// a Router, its validated value is injected into the context under itself, so any
// descendant handler can retrieve it type-safely via `ctx.value(theGlobalFlag)`.
export interface GlobalFlag<N extends string = string, T = unknown>
  extends ContextKey<T>, Flag<N, T> {
  // Reconcile ContextKey's `name: string` with Flag's `name: N`.
  name: N;
}

// flag constructs a Flag while preserving the literal name and the type inferred
// from the zod schema. Prefer this over an object literal so that createHandler
// can infer a precise object for `handle`.
export function flag<N extends string, T>(
  name: N,
  description: string,
  schema: z.ZodType<T>,
  help?: string,
): Flag<N, T> {
  return { name, description, schema, help };
}

// globalFlag constructs a GlobalFlag. The returned value doubles as the typed
// ContextKey used to read the flag back out of the context.
export function globalFlag<N extends string, T>(
  name: N,
  description: string,
  schema: z.ZodType<T>,
): GlobalFlag<N, T> {
  return { id: Symbol(name), name, description, schema };
}

// FlagsOf maps a tuple of Flags to a typed object keyed by each flag's literal
// name, with values typed by z.infer of each schema.
type FlagsOf<F extends readonly Flag<string, any>[]> = {
  [E in F[number] as E["name"]]: E extends Flag<string, infer T> ? T : never;
};

export interface Argument<N extends string = string, T = unknown> {
  name: N;
  description: string;
  schema: z.ZodType<T>;
}

export function argument<N extends string, T>(
  name: N,
  description: string,
  schema: z.ZodType<T>,
): Argument<N, T> {
  return { name, description, schema };
}

type ArgumentsOf<A extends readonly Argument<string, any>[]> = {
  [E in A[number] as E["name"]]: E extends Argument<string, infer T> ? T : never;
};

type HandleFn<
  F extends readonly Flag<string, any>[],
  A extends readonly Argument<string, any>[],
> = (ctx: Context, flags: FlagsOf<F>, args: ArgumentsOf<A>) => Promise<void>;

export interface Handler {
  name(): string;
  description(): string;
  flags(): Flag[];
  arguments(): Argument[];
  // At runtime `handle` receives the validated, coerced flags object. The precise
  // shape is supplied to authors via createHandler's generic; the interface keeps
  // it erased so middleware can forward it uniformly.
  handle: HandleFn<any, any>;
  children(): Handler[];
}

type CreateHandlerInput<
  F extends readonly Flag<string, any>[],
  A extends readonly Argument<string, any>[],
> = {
  name: string;
  description: string;
  flags?: F;
  arguments?: A;
  handle?: HandleFn<F, A>;
  children?: Handler[];
};

const noOpHandler = async (_ctx: Context, _flags: any, _args: any): Promise<void> => {};

class BaseHandler implements Handler {
  _name: string;
  _description: string;
  _flags: Flag[];
  _arguments: Argument[];
  _handle: HandleFn<any, any>;
  _children: Handler[];

  constructor(
    input: CreateHandlerInput<readonly Flag<string, any>[], readonly Argument<string, any>[]>,
  ) {
    this._name = input.name;
    this._description = input.description;
    this._flags = (input.flags ?? []) as Flag[];
    this._arguments = (input.arguments ?? []) as Argument[];
    this._handle = (input.handle ?? noOpHandler) as HandleFn<any, any>;
    this._children = input.children ?? [];
  }

  name(): string {
    return this._name;
  }

  description(): string {
    return this._description;
  }

  flags(): Flag[] {
    return this._flags;
  }

  arguments(): Argument[] {
    return this._arguments;
  }

  async handle(ctx: Context, flags: any, args: any): Promise<void> {
    await this._handle(ctx, flags, args);
  }

  children(): Handler[] {
    return this._children;
  }
}

// createHandler infers the flags tuple from `flags` (the `const` type parameter
// captures literal names), giving `handle` a precisely typed object derived from
// the zod schemas.
export function createHandler<
  const F extends readonly Flag<string, any>[] = readonly [],
  const A extends readonly Argument<string, any>[] = readonly [],
>(input: CreateHandlerInput<F, A>): Handler {
  return new BaseHandler(
    input as CreateHandlerInput<readonly Flag<string, any>[], readonly Argument<string, any>[]>,
  );
}
