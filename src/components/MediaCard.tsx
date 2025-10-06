import React from 'react';
import { Download, User, Youtube, Music } from 'lucide-react';

type Platform = 'youtube' | 'spotify' | 'default';

interface MediaData {
  title: string;
  subtitle: string;
  thumbnail: string;
  poster?: string | null;
}

interface MediaCardProps {
  mediaData: MediaData;
  platform: Platform;
  onImageDownload: (url: string, title: string, type: 'thumbnail' | 'poster') => void;
}

const MediaCard: React.FC<MediaCardProps> = ({ mediaData, platform, onImageDownload }) => {
  const isYoutube = platform === 'youtube';

  const imageSizeClass = isYoutube ? 'w-64 h-36' : 'w-48 h-48';
  const imageRoundingClass = isYoutube ? 'rounded-xl' : 'rounded-2xl';
  const platformBadgeClass = isYoutube 
    ? 'bg-red-600/20 text-red-400' 
    : 'bg-green-500/20 text-green-400';

  // --- THIS IS THE FIX ---
  // Determine which image to download when the hover icon is clicked.
  // This function now correctly uses the best URL provided by the backend.
  const handleHoverDownloadClick = () => {
    // For Spotify, always prioritize the high-res poster if it's available
    if (platform === 'spotify' && mediaData.poster) {
      onImageDownload(mediaData.poster, mediaData.title, 'poster');
      return;
    }

    // For YouTube (and as a fallback for Spotify), the backend has ALREADY
    // provided the best available thumbnail URL in `mediaData.thumbnail`.
    // We trust and use this URL directly. This prevents 404 errors while ensuring the best quality.
    onImageDownload(mediaData.thumbnail, mediaData.title, 'thumbnail');
  };

  return (
    <div className="relative overflow-hidden rounded-3xl shadow-2xl bg-gray-900 border border-gray-800">
      <div className="p-6 md:p-8">
        <div className="flex flex-col md:flex-row items-center md:items-start space-y-6 md:space-y-0 md:space-x-8">
          
          <div className={`relative flex-shrink-0 group mx-auto md:mx-0 ${imageSizeClass}`}>
            <img
              src={mediaData.thumbnail}
              alt={mediaData.title}
              className={`w-full h-full object-cover shadow-xl transition-all duration-300 group-hover:scale-105 ${imageRoundingClass}`}
            />
            <div
              // Updated onClick handler
              onClick={handleHoverDownloadClick}
              className={`absolute inset-0 bg-black bg-opacity-50 flex items-start justify-end p-2 opacity-0 group-hover:opacity-100 transition-opacity duration-300 cursor-pointer ${imageRoundingClass}`}
            >
              <div className="bg-white/20 backdrop-blur-sm p-2 rounded-full transform hover:scale-110 transition-transform">
                <Download className="w-6 h-6 text-white" />
              </div>
            </div>
          </div>

          <div className="flex-1 text-center md:text-left">
            <h2 className="text-2xl md:text-3xl font-bold text-white mb-3 leading-tight">
              {mediaData.title}
            </h2>
            
            <div className="flex items-center justify-center md:justify-start mb-6">
              <User className="w-5 h-5 mr-2 text-gray-400" />
              <span className="text-lg text-gray-300">
                {mediaData.subtitle}
              </span>
            </div>

            <div className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-semibold ${platformBadgeClass}`}>
              {isYoutube 
                ? <Youtube className="w-4 h-4 mr-2" /> 
                : <Music className="w-4 h-4 mr-2" />
              }
              {isYoutube ? 'YouTube' : 'Spotify'}
            </div>

            <div className="mt-6 p-4 bg-gray-800/50 rounded-xl border border-gray-700">
              <p className="text-gray-300 text-sm mb-2">Conversion Settings:</p>
              <div className="grid grid-cols-2 gap-4 text-xs">
                <div>
                  <span className="text-gray-400">Format:</span>
                  <span className="text-white ml-2 font-mono">.wav</span>
                </div>
                <div>
                  <span className="text-gray-400">Quality:</span>
                  <span className="text-white ml-2 font-mono">48000Hz</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default MediaCard;

