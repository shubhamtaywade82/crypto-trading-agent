#!/usr/bin/env node
import { render } from '@nemesis-oss/termina-core';
import App from './ui/App.js';

const instance = render(<App />, {
  alternateScreen: true,
  mouse: true,
  incrementalRendering: true,
});

instance.waitUntilExit().catch((err: unknown) => {
  if (err) console.error(err);
  process.exit(1);
});

