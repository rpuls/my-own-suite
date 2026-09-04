// Reading a Suite Manager API response, in one place.
//
// Three screens had a byte-identical copy of this, which meant the reference
// below could have been added to one of them and quietly missing from the other
// two — exactly the failure it exists to prevent.
export async function jsonResponse<T>(response: Response, fallback: string): Promise<T> {
  const body = await response.json().catch(() => ({})) as T & { error?: string; reference?: string };
  if (response.ok) return body;

  const message = typeof body.error === 'string' ? body.error : fallback;
  // An internal error deliberately tells the owner nothing about what broke, so
  // on its own it is unreportable: every one of them reads "Internal server
  // error." The reference is the only thing that ties what they saw to the line
  // the server wrote, which is why it belongs in the message they can copy
  // rather than in a response field nothing renders. CONTRIBUTING.md asks for
  // it by name.
  const reference = typeof body.reference === 'string' ? body.reference : '';
  throw new Error(reference ? `${message} (reference ${reference})` : message);
}
