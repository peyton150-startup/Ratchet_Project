// DOM harness for component tests. Registers a jsdom environment as the global document/window so
// React can render, then flags the React act() environment. Import this FIRST in any component test.
import 'global-jsdom/register';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
