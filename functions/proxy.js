const express = require('express');
const axios = require('axios');
const cors = require('cors');
const url = require('url');
const { v4: uuidv4 } = require('uuid');

// Simplified sites.js data (subset for brevity)
const defaultSites = {
  "Bloomberg": {
    domain: "bloomberg.com",
    allow_cookies: 1,
    block_regex: /(\.cm\.bloomberg\.com\/|assets\.bwbx\.io\/s\d\/javelin\/.+\/transporter\/)/
  },
  "The New York Times": {
    domain: "nytimes.com",
    allow_cookies: 1,
    block_regex: /(\.nytimes\.com\/meter\.js|mwcm\.nyt\.com\/.+\.js|cooking\.nytimes\.com\/api\/.+\/access)/,
    useragent: "googlebot"
  },
  "Australia News Corp": {
    domain: "###_au_news_corp",
    group: ["adelaidenow.com.au", "couriermail.com.au"],
    allow_cookies: 1,
    block_regex: /cdn\.ampproject\.org\/v\d\/amp-subscriptions-.+\.js/,
    useragent: "googlebot"
  },
  "Poool.fr": {
    domain: "poool.fr",
    allow_cookies: 1,
    block_regex_general: /\.poool\.fr\//
  }
};

const grouped_sites = {};
const au_news_corp_domains = ["adelaidenow.com.au", "couriermail.com.au"];
const nofix_sites = ["lemonde.fr", "nature.com"];

// Expand site rules (adapted from sites.js)
function expandSiteRules(sites) {
  for (let site in sites) {
    const rule = sites[site];
    if (rule.group) {
      grouped_sites[rule.domain] = rule.group;
    }
  }
}
expandSiteRules(defaultSites);

// Initialize custom flex domains
const custom_flex_not = {
  "###_au_news_corp": ["perthnow.com.au"]
};
let custom_flex = {};
let custom_flex_domains = [];
let custom_flex_not_domains = Object.values(custom_flex_not).flat();

function initCustomFlexDomains() {
  custom_flex = {};
  custom_flex_domains = [];
  custom_flex_not_domains = Object.values(custom_flex_not).flat();
}
initCustomFlexDomains();

const app = express();
app.use(cors());
app.use(express.json());

// Proxy endpoint
app.post('/proxy', async (req, res) => {
  const { url: targetUrl } = req.body;
  if (!targetUrl) {
    return res.status(400).json({ error: 'URL is required' });
  }

  try {
    const parsedUrl = url.parse(targetUrl);
    const hostname = parsedUrl.hostname;
    let siteRule = null;
    let isGroupSite = false;

    // Find matching site rule
    for (const [siteName, rule] of Object.entries(defaultSites)) {
      if (rule.domain === hostname) {
        siteRule = rule;
        break;
      } else if (rule.group && rule.group.includes(hostname)) {
        siteRule = rule;
        isGroupSite = true;
        break;
      }
    }

    // Check if site is in nofix_sites
    if (nofix_sites.includes(hostname)) {
      return res.json({ status: 'nofix', message: `Site ${hostname} is not supported` });
    }

    // Prepare headers
    const headers = {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Connection': 'keep-alive'
    };

    // Apply site-specific rules
    if (siteRule) {
      // User-Agent
      if (siteRule.useragent === 'googlebot') {
        headers['User-Agent'] = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
      } else if (siteRule.useragent === 'bingbot') {
        headers['User-Agent'] = 'Mozilla/5.0 (compatible; Bingbot/2.0; +http://www.bing.com/bingbot.htm)';
      }

      // Referer
      if (siteRule.referer === 'google') {
        headers['Referer'] = 'https://www.google.com/';
      } else if (siteRule.referer === 'facebook') {
        headers['Referer'] = 'https://www.facebook.com/';
      }

      // Random IP for X-Forwarded-For
      if (siteRule.random_ip) {
        headers['X-Forwarded-For'] = `${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}`;
      }
    }

    // Handle AMP redirects
    if (hostname.includes('cdn.ampproject.org') || hostname.includes('google.com/amp')) {
      const decodedUrl = decodeURIComponent(targetUrl.split('/s/')[1] || targetUrl);
      return res.json({ status: 'redirect', redirectedUrl: decodedUrl });
    }

    // Inkl bypass
    if (hostname === 'inkl.com' && targetUrl.includes('sign-in')) {
      const cleanUrl = targetUrl.replace(/(\?|&)sign-in=1/, '');
      return res.json({ status: 'redirect', redirectedUrl: cleanUrl });
    }

    // Make proxy request
    const response = await axios.get(targetUrl, {
      headers,
      responseType: 'text',
      validateStatus: (status) => status >= 200 && status < 600
    });

    // Cookie management
    let cookies = response.headers['set-cookie'] || [];
    if (siteRule && !siteRule.allow_cookies) {
      cookies = [];
    } else if (siteRule && siteRule.remove_cookies_select_drop) {
      cookies = cookies.filter(cookie => !siteRule.remove_cookies_select_drop.some(name => cookie.includes(name)));
    }

    // Script blocking
    let content = response.data;
    const blockedScripts = [];
    for (const rule of Object.values(defaultSites)) {
      if (rule.block_regex) {
        const regex = new RegExp(rule.block_regex);
        if (regex.test(targetUrl)) {
          blockedScripts.push(targetUrl);
          content = content.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
        }
      }
      if (rule.block_regex_general) {
        const regex = new RegExp(rule.block_regex_general);
        if (regex.test(targetUrl) && (!rule.excluded_domains || !rule.excluded_domains.includes(hostname))) {
          blockedScripts.push(targetUrl);
          content = content.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
        }
      }
    }

    // Modify X-Frame-Options for nytimes.com
    if (hostname === 'nytimes.com') {
      response.headers['x-frame-options'] = 'SAMEORIGIN';
    }

    res.json({
      status: 'success',
      url: targetUrl,
      content: content.substring(0, 500) + '...', // Truncate for response
      headers: response.headers,
      cookies,
      blockedScripts,
      siteRule: siteRule ? { name: Object.keys(defaultSites).find(key => defaultSites[key] === siteRule), ...siteRule } : null
    });
  } catch (err) {
    res.status(500).json({ error: `Proxy error: ${err.message}` });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Proxy server running on port ${PORT}`);
});

exports.handler = async (event, context) => {
  const { url } = JSON.parse(event.body);
  // ... existing /proxy endpoint logic ...
  return {
    statusCode: 200,
    body: JSON.stringify(response)
  };
};