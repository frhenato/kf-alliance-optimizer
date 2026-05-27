/**
 * Serverless API Proxy for Decks of KeyForge
 * 
 * This proxy bypasses CORS restrictions by forwarding requests
 * from the frontend to the DoK API.
 * 
 * Compatible with: Vercel, Netlify Functions, Cloudflare Workers
 * 
 * Endpoints:
 *   GET /api/proxy?path=/v1/my-decks&page=0
 *   GET /api/proxy?path=/v1/cards
 */

const https = require('https')

const DOK_BASE = 'https://decksofkeyforge.com/public-api'

module.exports = async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Api-Key')

  if (req.method === 'OPTIONS') {
    return res.status(204).end()
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const apiKey = req.headers['api-key']
  if (!apiKey) {
    return res.status(400).json({ error: 'Api-Key header is required' })
  }

  // Get the path from query string
  const { path, ...params } = req.query
  if (!path) {
    return res.status(400).json({ error: 'path query parameter is required' })
  }

  // Build query string from remaining params
  const queryString = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')

  const fullPath = queryString ? `${path}?${queryString}` : path
  const url = `${DOK_BASE}${fullPath}`

  try {
    const data = await fetchFromDoK(url, apiKey)
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Cache-Control', 'no-cache')
    return res.status(200).json(data)
  } catch (err) {
    const status = err.status || 500
    return res.status(status).json({ error: err.message })
  }
}

function fetchFromDoK(url, apiKey) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const opts = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'Api-Key': apiKey,
        'Accept': 'application/json',
      },
      timeout: 30000,
    }

    const req = https.request(opts, (res) => {
      let raw = ''
      res.on('data', chunk => raw += chunk)
      res.on('end', () => {
        if (res.statusCode === 401 || res.statusCode === 403) {
          const err = new Error('API key rejected')
          err.status = res.statusCode
          return reject(err)
        }
        if (res.statusCode >= 400) {
          const err = new Error(`DoK API error: HTTP ${res.statusCode}`)
          err.status = res.statusCode
          return reject(err)
        }
        try {
          resolve(JSON.parse(raw))
        } catch (e) {
          reject(new Error('Invalid JSON from DoK API'))
        }
      })
    })

    req.on('timeout', () => {
      req.destroy()
      const err = new Error('Request timeout')
      err.status = 504
      reject(err)
    })

    req.on('error', reject)
    req.end()
  })
}
