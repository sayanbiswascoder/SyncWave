"use client"
import React, { useState, useEffect, useRef } from 'react';

// Types for props and search results
interface MusicQueueProps {
  roomCode: string;
}
interface SearchResult {
  id: string;
  title: string;
  thumbnail: string;
}

export default function MusicQueue({ roomCode }: MusicQueueProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [queue, setQueue] = useState<SearchResult[]>([]);
  const debounceRef = useRef<NodeJS.Timeout | null>(null);

  const handleSearch = async () => {
    // Detect direct YouTube URL
    const urlMatch = searchTerm.match(/[?&]v=([^&#]*)/);
    if (urlMatch) {
      const videoId = urlMatch[1];
      const mockResult: SearchResult = {
        id: videoId,
        title: `Video ${videoId}`,
        thumbnail: `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
      };
      setResults([mockResult]);
      return;
    }
    // Use server‑side scraping endpoint
    try {
      const res = await fetch(`/api/search?query=${encodeURIComponent(searchTerm)}`);
      if (!res.ok) throw new Error('Search request failed');
      const data = await res.json();
      const fetched: SearchResult[] = (data.results || []).map((item: any) => ({
        id: item.id,
        title: item.title,
        thumbnail: item.thumbnail,
      }));
      setResults(fetched);
    } catch (e) {
      console.error('Search error', e);
      setResults([]);
    }
  };

  // Debounce search when the user types
  useEffect(() => {
    if (!searchTerm) {
      setResults([]);
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      handleSearch();
    }, 500); // 500 ms debounce
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [searchTerm]);

  const addToQueue = (item: SearchResult) => {
    setQueue((prev) => [...prev, item]);
  };

  const playNow = (item: SearchResult) => {
    setQueue([item, ...queue]);
  };

  return (
    <section className="p-4 bg-gray-900 rounded-lg text-white h-full flex flex-col">
      <h2 className="text-lg font-semibold mb-2">Music Queue</h2>
      <div className="flex gap-2 mb-4">
        <input
          type="text"
          className="flex-1 px-2 py-1 rounded bg-gray-800 text-white focus:outline-none"
          placeholder="Paste YouTube link or search..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
        />
        {/* Optional manual trigger */}
        <button className="px-3 py-1 bg-blue-600 rounded hover:bg-blue-500" onClick={handleSearch}>
          Search
        </button>
      </div>

      <div className="flex flex-col space-y-2 mb-4 max-h-48 overflow-y-auto">
        {results.map((r) => (
          <div key={r.id} className="flex items-center gap-2 bg-gray-800 p-2 rounded">
            <button className="px-2 py-1 bg-green-600 rounded text-sm hover:bg-green-500" onClick={() => playNow(r)}>
              Play
            </button>
            <img src={r.thumbnail} alt={r.title} className="w-12 h-9 object-cover rounded" />
            <span className="flex-1 truncate">{r.title}</span>
            <button className="px-2 py-1 bg-gray-600 rounded text-sm hover:bg-gray-500" onClick={() => addToQueue(r)}>
              Add to Queue
            </button>
          </div>
        ))}
      </div>

      <div className="flex flex-col flex-1 overflow-y-auto">
        <h3 className="text-md font-medium mb-2">Queued Tracks</h3>
        {queue.length === 0 && <p className="text-gray-400">Queue is empty.</p>}
        {queue.map((q, idx) => (
          <div key={`${q.id}-${idx}`} className="flex items-center gap-2 p-1">
            <span className="w-6 text-center">{idx + 1}.</span>
            <img src={q.thumbnail} alt={q.title} className="w-10 h-8 object-cover rounded" />
            <span className="flex-1 truncate">{q.title}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
