// Identifiers for the payload schemas the application knows how to render.
// Kept in their own module so lib/environments.ts can name a schema without
// importing the (much larger) schema definitions.

export type PayloadSchemaId = "development" | "ree";
