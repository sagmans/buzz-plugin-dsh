// Puts the Settings tab's Save action in the agent panel's sticky footer, as
// the app's own agents have it. The app gives its footer slot to its own
// views through a React context that a plugin cannot reach: this bundle has
// its own copy of that context. So the plugin finds the same slot in the page
// and gives it to the bundled `AgentSaveButton` through the bundled context.
// The slot's class name is a content hash, the same in the app's build of the
// pinned buzz-app revision. Where no slot is found (another host screen, a
// changed app), the Save action stays inline below the form, as buzz-app's
// own `AgentSaveButton` does without a footer.
// (The same module as buzz-plugin-opencode's src/save-footer.tsx.)
import { createElement as h, useLayoutEffect, useMemo, useState } from "react";
import pageStyles from "@buzz/bundled/agents/AgentsPage.module.css";
import { AgentSaveFooter } from "@buzz/features/agents/AgentSaveButton";

/** The footer slot that buzz-app's agent panel (AgentDetails) renders. */
const SLOT_CLASS = pageStyles.saveFooter;

/** The panel's footer slot nearest to the form, or null. */
function findSlot(form) {
  if (!SLOT_CLASS) return null;
  const slot = `.${CSS.escape(SLOT_CLASS)}`;
  let node = document.getElementById(form)?.parentElement ?? null;
  while (node && !node.querySelector(slot)) node = node.parentElement;
  return node?.querySelector(slot) ?? null;
}

/** Gives the panel's footer slot to the `AgentSaveButton` of `form`, the id
 * of the settings form inside the panel. */
export function PanelSaveFooter({ form, children }) {
  const [target, setTarget] = useState(null);
  // Before paint, so a visible Save action never shows inline first.
  useLayoutEffect(() => setTarget(findSlot(form)), [form]);
  const footer = useMemo(() => (target ? { target } : null), [target]);
  return h(AgentSaveFooter, { value: footer }, children);
}
