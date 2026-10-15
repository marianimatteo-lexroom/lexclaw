import { Type } from "typebox";

/** Lexroom connection settings of the Ada plugin config. */
export const lexroomConfigProperties = {
  accessToken: Type.Optional(
    Type.String({ description: "Lexroom bearer token for this lawyer. Do not commit it." }),
  ),
  baseUrl: Type.Optional(Type.String({ description: "Lexroom API base URL." })),
  timeoutMs: Type.Optional(
    Type.Integer({
      minimum: 1000,
      description:
        "Cap in milliseconds on one whole Lexroom research or draft call, streaming included. Default 180000.",
    }),
  ),
  idleTimeoutMs: Type.Optional(
    Type.Integer({
      minimum: 1000,
      description:
        "Abandon a Lexroom call after this many milliseconds with no data from the stream. Default 45000.",
    }),
  ),
  answerTimeoutMs: Type.Optional(
    Type.Integer({
      minimum: 1000,
      description:
        "Research only: give up when no answer text has appeared after this many milliseconds, even if the stream keeps sending progress. Lifted once the answer starts. Default 60000.",
    }),
  ),
  researchModules: Type.Optional(
    Type.Array(Type.String({ minLength: 1 }), {
      minItems: 1,
      description:
        'Lexroom modules searched by ada_research and deadline briefs when the call names none, for example ["Civile", "Societario"]. Default ["Civile"].',
    }),
  ),
};
