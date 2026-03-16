import { startStack } from './stack.js';

export default async function globalSetup() {
  await startStack();
}
