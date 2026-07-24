import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import { applyBootConfig } from './app/bootConfig';
import { startRouter } from './app/router';
import { mountShell } from './app/shell';
import { createAppStore } from './app/store';
import { bindSlotSignal as bindRulesSlot } from './core/rules/rules-store';
import { bindSlotSignal as bindSchemaSlot } from './core/schema/schema-store';

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) throw new Error('QuaC: #app root element missing');
const store = createAppStore();
// P14: mirror the module-scoped schema/rules slot states onto the AppStore so
// the Run-button state machine reads plain store signals.
bindSchemaSlot(store.slots.schema);
bindRulesSlot(store.slots.rules);
// mountShell renders the default Load view synchronously, so the Dataset card's
// URL loader is registered before P16's boot flow reads the fragment below.
mountShell(root, { store, router: startRouter() });
void applyBootConfig(store);
