import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import { installDevHooks } from './app/devHooks';
import { startRouter } from './app/router';
import { mountShell } from './app/shell';
import { createAppStore } from './app/store';

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) throw new Error('QuaC: #app root element missing');
const store = createAppStore();
mountShell(root, { store, router: startRouter() });
installDevHooks(store);
