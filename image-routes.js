const express = require('express');
const jwt = require('jsonwebtoken');
const ImageKit = require('imagekit');
const { getAiConfig } = require('./ai-config');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'labour_management_super_secret_key_123';

/* ------------------------------------------------------------------
   Image Studio — generate artwork with Gemini's image models.

   POST /api/image/generate
     body: {
       prompt: string,
       model?: 'pro' | 'flash' | 'flash-lite',
       aspect?: '1:1' | '4:3' | '3:4' | '16:9' | '9:16',
       references?: [{ mimeType: string, data: base64 }]   // up to 4
     }
     -> { url, mimeType, ms, note }

   The Gemini key never leaves the server. Finished images are uploaded
   to ImageKit so they survive a refresh and open on any device; if that
   upload fails the image still comes back inline as a data URL.
   ------------------------------------------------------------------ */

const MODELS = {
  pro: 'gemini-3-pro-image',
  flash: 'gemini-3.1-flash-image',
  'flash-lite': 'gemini-3.1-flash-lite-image'
};

const ASPECTS = ['1:1', '4:3', '3:4', '16:9', '9:16'];

const MAX_PROMPT = 6000;
const MAX_REFERENCES = 4;
const MAX_REFERENCE_BYTES = 7 * 1024 * 1024; // 7 MB per reference image

const imagekit = new ImageKit({
  publicKey: process.env.IMAGEKIT_PUBLIC_KEY || 'public_LB0AyCgim15VO491kDtVm0Fo798=',
  privateKey: process.env.IMAGEKIT_PRIVATE_KEY || 'private_nRKX1cLNUCab5WJX4cWNCnWqk3U=',
  urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT || 'https://ik.imagekit.io/rishii'
});

const authMiddleware = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'Authorization token required' });
    }
    req.auth = jwt.verify(authHeader.split(' ')[1], JWT_SECRET);
    next();
  } catch (error) {
    return res.status(401).json({ message: 'Invalid token' });
  }
};

/** Reference images the user attached, sanitised into Gemini parts. */
function referenceParts(references) {
  if (!Array.isArray(references)) return [];

  return references
    .slice(0, MAX_REFERENCES)
    .filter(ref => ref && typeof ref.data === 'string' && /^image\//.test(ref.mimeType || ''))
    .filter(ref => Buffer.byteLength(ref.data, 'base64') <= MAX_REFERENCE_BYTES)
    .map(ref => ({ inlineData: { mimeType: ref.mimeType, data: ref.data } }));
}

router.get('/status', authMiddleware, async (req, res) => {
  try {
    const config = await getAiConfig();
    res.json({ ready: !!config.gemini.apiKey });
  } catch (error) {
    res.status(500).json({ message: 'AI configuration could not be loaded.' });
  }
});

router.post('/generate', authMiddleware, async (req, res) => {
  const { prompt, model, aspect, references } = req.body || {};

  if (typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ message: 'Prompt is required.' });
  }

  const modelId = MODELS[model] || MODELS.pro;
  const aspectRatio = ASPECTS.includes(aspect) ? aspect : '1:1';

  let apiKey;
  try {
    apiKey = (await getAiConfig()).gemini.apiKey;
  } catch (error) {
    return res.status(500).json({ message: 'AI configuration could not be loaded.' });
  }
  if (!apiKey) {
    return res.status(503).json({ message: 'Gemini ki API key server par set nahi hai.' });
  }

  const startedAt = Date.now();

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [...referenceParts(references), { text: prompt.slice(0, MAX_PROMPT) }]
            }
          ],
          generationConfig: {
            responseModalities: ['TEXT', 'IMAGE'],
            imageConfig: { aspectRatio }
          }
        })
      }
    );

    const data = await response.json();
    if (!response.ok) {
      return res
        .status(response.status)
        .json({ message: data?.error?.message || 'Image generation failed.' });
    }

    const parts = data?.candidates?.[0]?.content?.parts || [];
    const imagePart = parts.find(part => part.inlineData || part.inline_data);

    if (!imagePart) {
      // The model answered in words instead of drawing — usually a blocked
      // or unclear prompt. Pass its own explanation back to the user.
      const note = parts.map(part => part.text || '').join(' ').trim();
      const blocked = data?.candidates?.[0]?.finishReason;
      return res.status(422).json({
        message: note || `Image nahi ban saki${blocked ? ` (${blocked})` : ''}. Prompt thoda badal kar dekhein.`
      });
    }

    const inline = imagePart.inlineData || imagePart.inline_data;
    const mimeType = inline.mimeType || inline.mime_type || 'image/jpeg';
    const buffer = Buffer.from(inline.data, 'base64');
    const note = parts.map(part => part.text || '').join(' ').trim();

    // Park the result on ImageKit so it has a permanent, shareable URL.
    let url = null;
    try {
      const extension = mimeType.includes('png') ? 'png' : 'jpg';
      const upload = await imagekit.upload({
        file: buffer,
        fileName: `ai-studio-${Date.now()}.${extension}`,
        folder: '/ai-studio',
        useUniqueFileName: true
      });
      url = upload.url;
    } catch (uploadError) {
      console.error('ImageKit upload failed:', uploadError.message);
    }

    res.json({
      url: url || `data:${mimeType};base64,${inline.data}`,
      stored: !!url,
      mimeType,
      bytes: buffer.length,
      note,
      model: modelId,
      aspect: aspectRatio,
      ms: Date.now() - startedAt
    });
  } catch (error) {
    console.error('Image generation failed:', error.message);
    res.status(500).json({ message: error.message || 'Image generation failed.' });
  }
});

module.exports = router;
