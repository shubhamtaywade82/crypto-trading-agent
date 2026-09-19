#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import App from './ui/App.js';

// Use alternate screen buffer in TTY to eliminate terminal scrollback tearing and hide cursor
if (process.stdout.isTTY) {
  process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[H');
}

const instance = render(<App />);

const cleanup = () => {
  if (process.stdout.isTTY) {
    process.stdout.write('\x1b[?25h\x1b[?1049l');
  }
};

instance.waitUntilExit().then(cleanup);
process.on('SIGINT', () => {
  cleanup();
  process.exit(0);
});
process.on('exit', cleanup);
