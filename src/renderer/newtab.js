'use strict';

// The search box follows the search engine chosen in Settings (passed in the page address).
const ENDPOINTS = {
  google: 'https://www.google.com/search',
  duckduckgo: 'https://duckduckgo.com/',
  bing: 'https://www.bing.com/search',
};

const engine = new URLSearchParams(location.search).get('engine');
if (Object.hasOwn(ENDPOINTS, engine)) document.getElementById('search').action = ENDPOINTS[engine];
