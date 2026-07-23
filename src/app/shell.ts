import { assetUrl } from './urlBase';

export interface ShellRegions {
  header: HTMLElement;
  main: HTMLElement;
}

/**
 * P01 placeholder shell: header banner + privacy line + empty main region.
 * Nav tabs, Share button, and GitHub link arrive in P04.
 */
export function mountShell(root: HTMLElement): ShellRegions {
  const header = document.createElement('header');
  header.className = 'q-header';

  const logo = document.createElement('img');
  logo.src = assetUrl('logo/quac-logo.svg');
  logo.alt = ''; // decorative; the wordmark carries the name
  logo.width = 40;
  logo.height = 40;
  logo.className = 'q-logo';

  const titles = document.createElement('div');
  const title = document.createElement('h1');
  title.className = 'q-title';
  title.textContent = 'QuaC';
  const subtitle = document.createElement('p');
  subtitle.className = 'q-subtitle';
  subtitle.textContent = 'in-browser data quality control';
  titles.append(title, subtitle);

  header.append(logo, titles);

  const privacy = document.createElement('p');
  privacy.className = 'q-privacy';
  privacy.textContent = 'Your data never leaves this browser. No uploads, no servers, no storage.';

  const main = document.createElement('main');
  main.className = 'q-main';

  root.append(header, privacy, main);
  return { header, main };
}
