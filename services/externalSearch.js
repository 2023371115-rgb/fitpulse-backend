const axios = require('axios');

const provider = process.env.EXTERNAL_SEARCH_PROVIDER || 'google';

// ─── Web Search ───────────────────────────────────────────────────────────────
async function googleSearch(query, options = {}) {
  const apiKey = process.env.GOOGLE_CSE_API_KEY;
  const cx = process.env.GOOGLE_CSE_ID;
  if (!apiKey || !cx) {
    throw new Error('Google Custom Search API key or search engine ID is not configured');
  }

  const params = {
    key: apiKey,
    cx,
    q: query,
    num: options.num || 10,
  };

  const response = await axios.get('https://www.googleapis.com/customsearch/v1', { params });
  const items = response.data.items || [];

  return items.map(item => ({
    title: item.title,
    snippet: item.snippet || '',
    link: item.link,
    displayLink: item.displayLink,
    image:
      item.pagemap?.cse_image?.[0]?.src ||
      item.pagemap?.cse_thumbnail?.[0]?.src ||
      null,
  }));
}

// ─── Image Search ─────────────────────────────────────────────────────────────
async function googleImageSearch(query, options = {}) {
  const apiKey = process.env.GOOGLE_CSE_API_KEY;
  const cx = process.env.GOOGLE_CSE_ID;
  if (!apiKey || !cx) {
    throw new Error('Google Custom Search API key or search engine ID is not configured');
  }

  const params = {
    key: apiKey,
    cx,
    q: query,
    searchType: 'image',
    num: options.num || 10,
    ...(options.imgSize && { imgSize: options.imgSize }),
    ...(options.imgType && { imgType: options.imgType }),
    ...(options.imgColorType && { imgColorType: options.imgColorType }),
    ...(options.safe && { safe: options.safe }),
  };

  const response = await axios.get('https://www.googleapis.com/customsearch/v1', { params });
  const items = response.data.items || [];

  return items.map(item => ({
    title: item.title,
    snippet: item.snippet || '',
    imageUrl: item.link,
    sourceUrl: item.image?.contextLink || null,
    sourceDomain: item.displayLink,
    thumbnailUrl: item.image?.thumbnailLink || null,
    thumbnailWidth: item.image?.thumbnailWidth || null,
    thumbnailHeight: item.image?.thumbnailHeight || null,
    width: item.image?.width || null,
    height: item.image?.height || null,
    fileFormat: item.fileFormat || null,
  }));
}

// ─── Suggestions ──────────────────────────────────────────────────────────────
async function googleSuggest(query) {
  if (!query) return [];
  const response = await axios.get('https://suggestqueries.google.com/complete/search', {
    params: { client: 'firefox', q: query },
    headers: { Accept: 'application/json' },
  });
  return Array.isArray(response.data) && Array.isArray(response.data[1])
    ? response.data[1]
    : [];
}

// ─── DuckDuckGo Instant Answer ───────────────────────────────────────────────
async function duckDuckGoInstantAnswer(query) {
  const response = await axios.get('https://api.duckduckgo.com/', {
    params: {
      q: query,
      format: 'json',
      no_html: 1,
      no_redirect: 1,
      skip_disambig: 0,
    },
  });

  const data = response.data || {};
  const results = [];

  if (data.AbstractText || data.Heading) {
    results.push({
      title: data.Heading || query,
      snippet: data.AbstractText || '',
      link: data.AbstractURL || `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
      displayLink: data.AbstractSource || 'DuckDuckGo',
      image: data.Image ? `https://duckduckgo.com${data.Image}` : null,
    });
  }

  for (const topic of flattenDuckDuckGoTopics(data.RelatedTopics || [])) {
    if (!topic.FirstURL && !topic.Text) continue;
    results.push({
      title: topic.Text?.split(' - ')[0] || topic.FirstURL || query,
      snippet: topic.Text || '',
      link: topic.FirstURL || `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
      displayLink: 'DuckDuckGo',
      image: topic.Icon?.URL ? `https://duckduckgo.com${topic.Icon.URL}` : null,
    });
  }

  if (results.length === 0) {
    results.push({
      title: `Buscar "${query}" en DuckDuckGo`,
      snippet: 'DuckDuckGo Instant Answer no devolvio una respuesta directa para esta consulta.',
      link: `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
      displayLink: 'DuckDuckGo',
      image: null,
    });
  }

  return results.slice(0, 10);
}

function flattenDuckDuckGoTopics(topics) {
  return topics.flatMap(topic => {
    if (Array.isArray(topic.Topics)) return flattenDuckDuckGoTopics(topic.Topics);
    return [topic];
  });
}

// ─── Bing Web Search ──────────────────────────────────────────────────────────
async function bingSearch(query) {
  const apiKey = process.env.BING_SEARCH_API_KEY;
  const endpoint =
    process.env.BING_SEARCH_ENDPOINT || 'https://api.bing.microsoft.com/v7.0/search';
  if (!apiKey) throw new Error('Bing Search API key is not configured');

  const response = await axios.get(endpoint, {
    headers: { 'Ocp-Apim-Subscription-Key': apiKey },
    params: { q: query, count: 10 },
  });

  return (response.data.webPages?.value || []).map(item => ({
    title: item.name,
    snippet: item.snippet,
    link: item.url,
    displayLink: item.displayUrl,
  }));
}

// ─── Renderizado HTML de imágenes (helper opcional) ───────────────────────────
function renderImagesAsHTML(imageResults, title = 'Resultados de imágenes') {
  const cards = imageResults
    .map(
      img => `
      <div class="img-card">
        <a href="${img.sourceUrl || img.imageUrl}" target="_blank" rel="noopener noreferrer">
          <img src="${img.thumbnailUrl || img.imageUrl}" alt="${img.title}" />
          <h3 class="img-title">${img.title}</h3>
          <p class="img-source">${img.sourceDomain || ''}</p>
        </a>
      </div>`
    )
    .join('');

  return `
    <style>
      .img-grid { display: flex; flex-wrap: wrap; gap: 12px; padding: 16px; }
      .img-card { width: 200px; border: 1px solid #ddd; border-radius: 8px; overflow: hidden; font-family: sans-serif; font-size: 12px; }
      .img-card img { width: 100%; height: 150px; object-fit: cover; }
      .img-title { padding: 4px 8px; font-weight: bold; margin: 0; }
      .img-source { padding: 0 8px 8px; color: #555; margin: 0; }
      .img-card a { text-decoration: none; color: inherit; }
    </style>
    <div class="img-grid">
      ${cards}
    </div>`;
}

// ─── Entry point principal ────────────────────────────────────────────────────
async function externalSearch(query, options = {}) {
  if (options.type === 'suggest') {
    return googleSuggest(query);
  }

  if (options.type === 'image') {
    return googleImageSearch(query, options);
  }

  try {
    if (provider === 'duckduckgo') return duckDuckGoInstantAnswer(query);
    if (provider === 'bing') return bingSearch(query);
    return googleSearch(query, options);
  } catch (err) {
    const message = err?.message?.toLowerCase() || '';
    if (message.includes('google custom search') || message.includes('bing search api key')) {
      const suggestions = await googleSuggest(query);
      return suggestions.map(s => ({
        title: s,
        snippet: '',
        link: `https://www.google.com/search?q=${encodeURIComponent(s)}`,
        displayLink: 'Google Suggestions',
      }));
    }
    throw err;
  }
}

module.exports = { externalSearch, renderImagesAsHTML };
