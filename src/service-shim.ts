// The build puts this module in place of buzz-app's `features/agents/service.ts`
// for every bundled module. The Goose runtime takes only `fromOwner` from it
// at run time; the rest are types, which the build erases. Bundling the real
// service would copy the app's agent, identity and native modules, with their
// own state, into the plugin. The build fails if a bundled module asks for an
// export that is not here.
export { fromOwner } from "@app/features/agents/owner-attestation";
