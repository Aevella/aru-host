// Public module entry for new installers. Older fixed-file installers receive
// the same owner through the existing replica payload, without a second state path.
export { createMobileCollaboratorIdentityHost } from "./mobile-collaborator-replicas.mjs";
