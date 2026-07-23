import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import { mountShell } from './app/shell';

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) throw new Error('QuaC: #app root element missing');
mountShell(root);
