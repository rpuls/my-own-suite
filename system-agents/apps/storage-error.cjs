// A refusal written for the owner, which Suite Manager shows as it is.
class StorageError extends Error {
  constructor(message) {
    super(message);
    this.code = 'APP_STORAGE_UNAVAILABLE';
    this.statusCode = 409;
  }
}

module.exports = { StorageError };
