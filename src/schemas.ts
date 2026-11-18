import { z } from "zod";

export const jsonObjectSchema = z.record(z.string(), z.unknown());
export const jsonValueSchema = z.unknown();
export const jsonDocumentSchema = z.union([jsonObjectSchema, z.array(z.unknown())]);
