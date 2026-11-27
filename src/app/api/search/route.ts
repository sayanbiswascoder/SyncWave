import { NextResponse } from 'next/server';

// GET /api/search?query=...
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get('query');
  if (!query) {
    return NextResponse.json({ error: 'Missing query parameter' }, { status: 400 });
  }
  try {
    const response = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'text/html',
      },
    });
    const html = await response.text();

    // Extract ytInitialData JSON
    const match = html.match(/var ytInitialData = (\{.+?\});/s);
    if (!match) {
      return NextResponse.json({ error: 'Failed to extract data' }, { status: 500 });
    }
    const data = JSON.parse(match[1]);
    const contents =
      data.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents?.[0]
        ?.itemSectionRenderer?.contents || [];
    const results = [];
    for (const item of contents) {
      if (!item.videoRenderer) continue;
      const vr = item.videoRenderer;
      const videoId = vr.videoId;
      const title = vr.title?.runs?.[0]?.text || '';
      const thumbnails = vr.thumbnail?.thumbnails;
      const thumbnail = thumbnails?.[thumbnails.length - 1]?.url || '';
      results.push({ id: videoId, title, thumbnail });
      if (results.length >= 10) break;
    }
    return NextResponse.json({ results });
  } catch (e) {
    console.error('Search error', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
