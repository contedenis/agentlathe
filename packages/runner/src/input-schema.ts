import { Ajv, type ValidateFunction } from "ajv";

// A fresh Ajv per compile: a shared instance rejects duplicate $ids.
export function compileInputSchema(schema: unknown): ValidateFunction | null {
  if (typeof schema !== "object" || schema === null) return null;
  try {
    return new Ajv({ allErrors: true, strict: false }).compile(schema);
  } catch {
    return null;
  }
}

export function describeSchemaErrors(validate: ValidateFunction): string {
  return (validate.errors ?? [])
    .map((error) => `${error.instancePath || "input"} ${error.message}`)
    .join("; ");
}
