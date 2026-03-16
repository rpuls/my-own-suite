import { stopStack } from './stack.js';

export default async function globalTeardown() {
  stopStack();
}
