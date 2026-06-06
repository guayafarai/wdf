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
      streams: [{ name: 'Demo', url: 'https://example.com/embed/barcelona-real-madrid' }],
      decoded_iframe_url: 'https://example.com/embed/barcelona-real-madrid'
    },
    {
      team_a: 'América',
      team_b: 'Chivas',
      league: 'Liga MX',
      date: today,
      time: '22:00',
      streams: [{ name: 'Demo', url: 'https://example.com/embed/america-chivas' }],
      decoded_iframe_url: 'https://example.com/embed/america-chivas'
    }
  ];
}

/**
 * Parsea diary_description con soporte para todos los formatos conocidos:
 *
 * 1. Multilinea:  "Liga:\nEquipo A vs Equipo B"
 * 2. Una línea con ":":  "Amistoso: Armenia vs Kazajstán"
 * 3. Una línea con " – " y equipos:  "Rugby – Premiership – Bath vs Leicester"
 * 4. Evento sin equipos (sin " vs "):  "F2 Monte Carlo – Sprint" / "Turf – Belmont"
 */
function parseDescription(desc) {
  const lines = desc.split('\n').map(s => s.trim()).filter(Boolean);

  let league = '';
  let team_a = '';
  let team_b = '';

  if (lines.length >= 2) {
    const firstLine = lines[0];
    league = firstLine.replace(/:$/, '').trim();

    const secondLine = lines[1];
    const vsIdx = secondLine.indexOf(' vs ');
    if (vsIdx !== -1) {
      team_a = secondLine.slice(0, vsIdx).trim();
      team_b = secondLine.slice(vsIdx + 4).trim();
    } else {
      league = league ? `${league} – ${secondLine}` : secondLine;
    }

  } else {
    const single = lines[0] || '';
    const vsIdx  = single.indexOf(' vs ');

    if (vsIdx === -1) {
      league = single;

    } else if (single.includes(':')) {
      const colonIdx = single.indexOf(':');
      league = single.slice(0, colonIdx).trim();
      const rest = single.slice(colonIdx + 1).trim();
      const ri = rest.indexOf(' vs ');
      if (ri !== -1) {
        team_a = rest.slice(0, ri).trim();
        team_b = rest.slice(ri + 4).trim();
      }

    } else if (single.includes(' – ')) {
      const dashParts = single.split(' – ');
      const lastPart  = dashParts[dashParts.length - 1];
      const li = lastPart.indexOf(' vs ');
      if (li !== -1) {
        team_a = lastPart.slice(0, li).trim();
        team_b = lastPart.slice(li + 4).trim();
        league = dashParts.slice(0, dashParts.length - 1).join(' – ').trim();
      } else {
        team_a = single.slice(0, vsIdx).trim();
        team_b = single.slice(vsIdx + 4).trim();
        league = '';
      }

    } else {
      team_a = single.slice(0, vsIdx).trim();
      team_b = single.slice(vsIdx + 4).trim();
    }
  }

  return { league, team_a, team_b };
}

/**
 * Extrae los streams de los embeds, deduplicando por decoded_iframe_url.
 * Devuelve array de { name, url } con URLs únicas solamente.
 */
function extractStreams(attributes) {
  const embeds = attributes.embeds && attributes.embeds.data;
  if (!Array.isArray(embeds) || embeds.length === 0) return [];

  const seen = new Set();
  const streams = [];

  for (const embed of embeds) {
    const attr = embed.attributes || {};
    const url  = (attr.decoded_iframe_url || '').trim();
    const name = (attr.embed_name || '').trim();

    if (!url) continue;
    if (seen.has(url)) continue;   // ← descarta duplicados por URL

    seen.add(url);
    streams.push({ name, url });
  }

  return streams;
}

function normalizeFromStrapi(m) {
  const attributes = m.attributes || {};
  const desc = attributes.diary_description || '';

  const { league, team_a, team_b } = parseDescription(desc);

  const date = attributes.date_diary || '';
  let time = attributes.diary_hour || '';
  if (time.length >= 5) time = time.slice(0, 5);

  // Streams deduplicados
  const streams = extractStreams(attributes);

  // decoded_iframe_url mantiene compatibilidad: primer stream disponible
  const decoded_iframe_url = streams.length > 0 ? streams[0].url : '';

  const id = String(m.id || `${team_a || league || 'evento'}-${date}`.replace(/\s+/g, '-'));
  const slugBase = team_a
    ? `${team_a}-vs-${team_b}-${date}`
    : `${league || 'evento'}-${date}`;
  const slug = slugBase.toLowerCase().replace(/\s+/g, '-').replace(/[–—]/g, '-');

  return { id, slug, team_a, team_b, league, date, time, streams, decoded_iframe_url };
}

function normalizeCanonical(m) {
  const team_a = m.team_a || '';
  const team_b = m.team_b || '';

  // Si viene con streams ya formados, respetar; si no, construir desde decoded_iframe_url
  let streams = [];
  if (Array.isArray(m.streams) && m.streams.length > 0) {
    // Deduplicar también en este caso
    const seen = new Set();
    for (const s of m.streams) {
      if (s.url && !seen.has(s.url)) {
        seen.add(s.url);
        streams.push(s);
      }
    }
  } else if (m.decoded_iframe_url) {
    streams = [{ name: 'Stream', url: m.decoded_iframe_url }];
  }

  const decoded_iframe_url = streams.length > 0 ? streams[0].url : (m.decoded_iframe_url || '');

  const id = String(
    m.id || `${team_a || m.league || 'evento'}-${m.date || ''}`.replace(/\s+/g, '-')
  );
  const slugBase = team_a
    ? `${team_a}-vs-${team_b}-${m.date || ''}`
    : `${m.league || 'evento'}-${m.date || ''}`;
  const slug = slugBase.toLowerCase().replace(/\s+/g, '-').replace(/[–—]/g, '-');

  return {
    id, slug, team_a, team_b,
    league: m.league || '',
    date: m.date || '',
    time: m.time || '',
    streams,
    decoded_iframe_url
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
        if (objectMatches.length > 0) list = objectMatches;
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
        JSON.stringify(fallback.map(m => normalizeCanonical(m)), null, 2)
      );
    } catch (e) {}
    return [];
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await fetchMatches();
}

export { fetchMatches };
