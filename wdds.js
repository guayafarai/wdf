import 'dotenv/config';
import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';

function getFallbackMatches() {
  const today = new Date().toISOString().slice(0, 10);
  return [
    {
      team_a: 'Barcelona',
      team_b: 'Real Madrid',
      league: 'La Liga',
      date: today,
      time: '20:00',
      decoded_iframe_url: 'https://example.com/embed/barcelona-real-madrid'
    },
    {
      team_a: 'América',
      team_b: 'Chivas',
      league: 'Liga MX',
      date: today,
      time: '22:00',
      decoded_iframe_url: 'https://example.com/embed/america-chivas'
    }
  ];
}

function normalizeFromStrapi(m) {
  const attributes = m.attributes || {};
  const desc = attributes.diary_description || '';
  const parts = desc.split('\n').map(s => s.trim()).filter(Boolean);

  let league;
  let team_a;
  let team_b;

  if (parts[0]) {
    const first = parts[0];
    league = first.includes(':') ? first.split(':')[0].trim() : first;
  }

  if (parts[1]) {
    const vsParts = parts[1].split(' vs ');
    if (vsParts.length >= 2) {
      team_a = vsParts[0].trim();
      team_b = vsParts[1].trim();
    }
  }

  const date = attributes.date_diary || '';
  let time = attributes.diary_hour || '';
  if (time.length >= 5) {
    time = time.slice(0, 5);
  }

  let decoded_iframe_url = '';
  const embeds = attributes.embeds && attributes.embeds.data;
  if (Array.isArray(embeds) && embeds.length > 0) {
    const firstEmbed = embeds[0].attributes || {};
    decoded_iframe_url = firstEmbed.decoded_iframe_url || '';
  }

  const idBase =
    m.id ||
    `${team_a || 'partido'}-${team_b || 'en-vivo'}-${date || ''}`.replace(/\s+/g, '-');
  const id = String(idBase);
  const slugBase = `${team_a || 'partido'}-vs-${team_b || 'en-vivo'}-${date || ''}`;
  const slug = slugBase.toLowerCase().replace(/\s+/g, '-');

  return {
    id,
    slug,
    team_a: team_a || 'Equipo A',
    team_b: team_b || 'Equipo B',
    league,
    date,
    time,
    decoded_iframe_url
  };
}

function normalizeCanonical(m) {
  const idBase =
    m.id ||
    `${m.team_a || 'partido'}-${m.team_b || 'en-vivo'}-${m.date || ''}`.replace(/\s+/g, '-');
  const id = String(idBase);
  const slugBase = `${m.team_a || 'partido'}-vs-${m.team_b || 'en-vivo'}-${m.date || ''}`;
  const slug = slugBase.toLowerCase().replace(/\s+/g, '-');

  return {
    id,
    slug,
    team_a: m.team_a || 'Equipo A',
    team_b: m.team_b || 'Equipo B',
    league: m.league,
    date: m.date || '',
    time: m.time || '',
    decoded_iframe_url: m.decoded_iframe_url || ''
  };
}

async function fetchMatches() {
  const url = process.env.MATCHES_JSON_URL;
  let rawText = '';
  try {
    const response = await axios.get(url, { timeout: 10000, responseType: 'text' });
    rawText = response.data;
    const data = JSON.parse(rawText);

    let list = [];

    console.log('Fetched matches JSON type:', typeof data);
    if (Array.isArray(data)) {
      console.log('Top-level array length:', data.length);
    } else if (data && typeof data === 'object') {
      console.log('Top-level keys:', Object.keys(data));
    }

    if (Array.isArray(data)) {
      list = data;
    } else if (data && Array.isArray(data.matches)) {
      list = data.matches;
    } else if (data && Array.isArray(data.partidos)) {
      list = data.partidos;
    } else if (data && Array.isArray(data.data)) {
      list = data.data;
    } else if (data && typeof data === 'object') {
      const values = Object.values(data);
      const arrayValues = values.filter(v => Array.isArray(v));
      if (arrayValues.length > 0) {
        list = arrayValues.flat();
      } else {
        const objectMatches = values.filter(
          v => v && typeof v === 'object' && !Array.isArray(v) && (v.team_a || v.team_b)
        );
        if (objectMatches.length > 0) {
          list = objectMatches;
        }
      }
    }

    if (!Array.isArray(list) || list.length === 0) {
      console.error('Unexpected matches JSON structure from MATCHES_JSON_URL, using fallback sample matches');
      const dir = path.join(process.cwd(), 'srce');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'errjgs.json'), rawText || JSON.stringify(data, null, 2));
      list = getFallbackMatches();
    }

    const enhanced = list.map(m =>
      m && m.attributes ? normalizeFromStrapi(m) : normalizeCanonical(m)
    );
    const dir = path.join(process.cwd(), 'srce');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'jgs.json'), JSON.stringify(enhanced, null, 2));
    console.log(`✓ Fetched ${enhanced.length} matches`);
    return enhanced;
  } catch (error) {
    console.error('Error fetching matches:', error.message);
    try {
      if (rawText) {
        const dir = path.join(process.cwd(), 'srce');
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, 'errjgs.json'), rawText);
      }
      const fallback = getFallbackMatches();
      const dir = path.join(process.cwd(), 'srce');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, 'jgs.json'),
        JSON.stringify(
          fallback.map(m => normalizeCanonical(m)),
          null,
          2
        )
      );
    } catch (e) {
    }
    return [];
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await fetchMatches();
}

export { fetchMatches };
