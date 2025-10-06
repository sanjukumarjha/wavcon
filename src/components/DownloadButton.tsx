import React from 'react';
import { Download } from 'lucide-react';

interface DownloadButtonProps {
  onClick: () => void;
  platform: string;
}

const DownloadButton: React.FC<DownloadButtonProps> = ({ onClick, platform }) => {
  return (
    <button
      onClick={onClick}
      className={`group relative px-12 py-5 rounded-2xl font-bold text-xl transition-all duration-300 transform hover:scale-105 active:scale-95 shadow-2xl ${
        platform === 'youtube' 
          ? 'bg-gradient-to-r from-red-600 to-red-700 hover:from-red-700 hover:to-red-800 text-white' 
          : 'bg-gradient-to-r from-green-500 to-green-600 hover:from-green-600 hover:to-green-700 text-white'
      }`}
    >
      <span className="flex items-center justify-center">
        <Download className="w-6 h-6 mr-3 group-hover:animate-bounce" />
        Download .wav
      </span>
      
      {/* Glow effect */}
      <div className={`absolute inset-0 rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-300 ${
        platform === 'youtube' 
          ? 'shadow-lg shadow-red-500/50' 
          : 'shadow-lg shadow-green-500/50'
      }`}></div>
      
      {/* Shimmer effect */}
      <div className="absolute inset-0 rounded-2xl overflow-hidden">
        <div className={`absolute inset-0 bg-gradient-to-r opacity-0 group-hover:opacity-100 transition-opacity duration-500 ${
          platform === 'youtube' 
            ? 'from-transparent via-red-400/30 to-transparent' 
            : 'from-transparent via-green-300/30 to-transparent'
        } -translate-x-full group-hover:translate-x-full transform transition-transform duration-1000`}></div>
      </div>
    </button>
  );
};

export default DownloadButton;