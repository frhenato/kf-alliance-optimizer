/**
 * Development Server
 * 
 * Serves static files from /public and proxies API requests to DoK.
 * For production, use Vercel/Netlify/Cloudflare with the /api folder.
 */

const http = require('http')
const https = require('https')
const fs = require('fs')
const path = require('path')
const url = require('url')

const PORT = process.env.PORT || 3001
const DOK_BASE = 'https://decksofkeyforge.com/public-api'

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true)
  const pathname = parsedUrl.pathname

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Api-Key')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    return res.end()
  }

  // API Proxy
  if (pathname === '/api/proxy') {
    const apiKey = req.headers['api-key']
    if (!apiKey) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: 'Api-Key header is required' }))
    }

    const dokPath = parsedUrl.query.path
    if (!dokPath) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: 'path query parameter is required' }))
    }

    // Build query string from remaining params
    const params = { ...parsedUrl.query }
    delete params.path
    const queryString = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&')

    const fullPath = queryString ? `${dokPath}?${queryString}` : dokPath
    const dokUrl = `${DOK_BASE}${fullPath}`

    try {
      const data = await fetchFromDoK(dokUrl, apiKey)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify(data))
    } catch (err) {
      const status = err.status || 500
      res.writeHead(status, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: err.message }))
    }
  }

  // Static files
  let filePath = pathname === '/' ? '/index.html' : pathname
  filePath = path.join(__dirname, 'public', filePath)

  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    return res.end('Not found')
  }

  const ext = path.extname(filePath)
  const contentType = MIME_TYPES[ext] || 'application/octet-stream'

  res.writeHead(200, { 'Content-Type': contentType })
  fs.createReadStream(filePath).pipe(res)
})

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
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
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

server.listen(PORT, () => {
  console.log(`Alliance Optimizer: http://localhost:${PORT}`)
  console.log('Press Ctrl+C to stop.')
})
