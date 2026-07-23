import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import { startRouter } from './app/router';
import { mountShell } from './app/shell';
import { createAppStore } from './app/store';

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) throw new Error('QuaC: #app root element missing');
mountShell(root, { store: createAppStore(), router: startRouter() });
