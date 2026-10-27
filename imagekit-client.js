const ImageKit = require('imagekit');

/**
 * The ImageKit client, configured from the environment.
 *
 * Nothing is hard-coded here: a private key in the source is a key anybody
 * with the repository can upload or delete with. If the three settings are not
 * in the environment, the upload refuses with a message that says so, rather
 * than failing somewhere deeper with a signature error.
 */
let client = null;

module.exports = function imagekitClient() {
  if (client) return client;
  const publicKey = process.env.IMAGEKIT_PUBLIC_KEY || '';
  const privateKey = process.env.IMAGEKIT_PRIVATE_KEY || '';
  const urlEndpoint = process.env.IMAGEKIT_URL_ENDPOINT || '';
  if (!publicKey || !privateKey || !urlEndpoint) {
    throw Object.assign(
      new Error('Picture uploads are not set up on this server yet: IMAGEKIT_PUBLIC_KEY, IMAGEKIT_PRIVATE_KEY and IMAGEKIT_URL_ENDPOINT are missing.'),
      { statusCode: 503 }
    );
  }
  client = new ImageKit({ publicKey, privateKey, urlEndpoint });
  return client;
};
