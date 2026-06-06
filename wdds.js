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

/**
 * Parsea diary_description con soporte para múltiples formatos:
 *
 * 1. Multilinea:
 *    "Liga:\nEquipo A vs Equipo B"
 *    "Liga: \nEquipo A vs Equipo B"
 *
 * 2. Una línea con ":" como separador liga/equipos:
 *    "Amistoso: Armenia vs Kazajstán"
 *
 * 3. Una línea con "–" como separadores (puede haber varios):
 *    "Rugby – Premiership – Bath Rugby vs Leicester Tigers"
 *    → league = "Rugby – Premiership", team_a = "Bath Rugby", team_b = "Leicester Tigers"
 *
 * 4. Evento sin equipos (no contiene " vs "):
 *    "F2 Monte Carlo – Sprint"
 *    → league = "F2 Monte Carlo – Sprint", team_a = "", team_b = ""
 */
function parseDescription(desc) {
  // Separar por salto de línea y limpiar
  const lines = desc.split('\n').map(s => s.trim()).filter(Boolean);

  let league = '';
  let team_a = '';
  let team_b = '';

  if (lines.length >= 2) {
    // ----- Formato multilinea -----
    // Línea 0: "Liga:" o "Liga"
    const firstLine = lines[0];
    league = firstLine.endsWith(':')
      ? firstLine.slice(0, -1).trim()
      : firstLine;

    // Línea 1: "Equipo A vs Equipo B" (puede tener " – " antes de vs)
    const secondLine = lines[1];
    const vsIdx = secondLine.indexOf(' vs ');
    if (vsIdx !== -1) {
      team_a = secondLine.slice(0, vsIdx).trim();
      team_b = secondLine.slice(vsIdx + 4).trim();
    } else {
      // Sin equipos en la segunda línea, añadir a la liga
      league = `${league} – ${secondLine}`.trim();
    }

  } else {
    // ----- Formato de una sola línea -----
    const single = lines[0] || '';
    const hasVs = single.includes(' vs ');

    if (!hasVs) {
      // Caso 4: evento sin equipos — toda la cadena es la liga
      // Normalizar separador "–" a algo legible pero sin cambiar el contenido
      league = single;

    } else if (single.includes(':')) {
      // Caso 2: "Liga: Equipo A vs Equipo B"
      const colonIdx = single.indexOf(':');
      league = single.slice(0, colonIdx).trim();
      const rest = single.slice(colonIdx + 1).trim();
      const vsIdx = rest.indexOf(' vs ');
      if (vsIdx !== -1) {
        team_a = rest.slice(0, vsIdx).trim();
        team_b = rest.slice(vsIdx + 4).trim();
      }

    } else if (single.includes(' – ')) {
      // Caso 3: "Deporte – Liga – Equipo A vs Equipo B"
      // El último segmento después del último "–" que contenga " vs " define los equipos;
      // todo lo anterior es la liga.
      const dashParts = single.split(' – ');
      const lastPart = dashParts[dashParts.length - 1];
      const vsIdx = lastPart.indexOf(' vs ');

      if (vsIdx !== -1) {
        team_a = lastPart.slice(0, vsIdx).trim();
        team_b = lastPart.slice(vsIdx + 4).trim();
        league = dashParts.slice(0, dashParts.length - 1).join(' – ').trim();
      } else {
        // El " vs " no está en el último segmento; buscar en toda la cadena
        const globalVsIdx = single.indexOf(' vs ');
        team_a = single.slice(0, globalVsIdx).trim();
        team_b = single.slice(globalVsIdx + 4).trim();
        // Liga vacía porque no podemos distinguirla
        league = '';
      }

    } else {
      // Fallback: toda la cadena tiene " vs " sin separador de liga
      const vsIdx = single.indexOf(' vs ');
      team_a = single.slice(0, vsIdx).trim();
      team_b = single.slice(vsIdx + 4).trim();
    }
  }

  return { league, team_a, team_b };
}

function normalizeFromStrapi(m) {
  const attributes = m.attributes || {};
  const desc = attributes.diary_description || '';

  const { league, team_a, team_b } = parseDescription(desc);

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

  const id = String(m.id || `${team_a || 'partido'}-${team_b || 'en-vivo'}-${date}`.replace(/\s+/g, '-'));
  const slugBase = team_a
    ? `${team_a}-vs-${team_b}-${date}`
    : `${league || 'evento'}-${date}`;
  const slug = slugBase.toLowerCase().replace(/\s+/g, '-');

  return {
    id,
    slug,
    team_a: team_a || '',
    team_b: team_b || '',
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
    team_a: m.team_a || '',
    team_b: m.team_b || '',
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
