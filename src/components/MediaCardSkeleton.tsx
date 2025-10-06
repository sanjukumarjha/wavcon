import React from 'react';

const MediaCardSkeleton: React.FC<{ platform: 'youtube' | 'spotify' | 'default' }> = ({ platform }) => {
  const isYoutube = platform === 'youtube';
  const themeClass = platform === 'default' ? 'bg-gray-200' : 'bg-gray-900 border border-gray-800';
  const skeletonClass = platform === 'default' ? 'bg-gray-300' : 'bg-gray-700';

  return (
    <div className={`relative overflow-hidden rounded-3xl shadow-2xl animate-pulse ${themeClass}`}>
      <div className="p-6 md:p-8">
        <div className="flex flex-col md:flex-row items-center md:items-start space-y-6 md:space-y-0 md:space-x-8">
          {/* Thumbnail Skeleton */}
          <div className={`flex-shrink-0 ${skeletonClass} ${
            isYoutube ? 'w-64 h-36 rounded-xl' : 'w-48 h-48 rounded-2xl'
          } mx-auto md:mx-0`}></div>

          {/* Metadata Skeleton */}
          <div className="flex-1 w-full text-center md:text-left">
            <div className={`h-8 rounded-lg ${skeletonClass} ${isYoutube ? 'w-full' : 'w-3/4'} mb-4`}></div>
            <div className={`h-6 rounded-lg ${skeletonClass} ${isYoutube ? 'w-3/4' : 'w-1/2'} mb-6`}></div>
            
            <div className="flex items-center justify-center md:justify-start">
                <div className={`w-24 h-8 rounded-full ${skeletonClass}`}></div>
            </div>
            
            <div className={`mt-6 p-4 ${platform === 'default' ? 'bg-gray-100' : 'bg-gray-800/50'} rounded-xl border ${platform === 'default' ? 'border-gray-300' : 'border-gray-700'}`}>
                <div className={`h-4 w-1/3 ${skeletonClass} rounded-lg mb-3`}></div>
                <div className="grid grid-cols-2 gap-4">
                    <div className={`h-4 w-full ${skeletonClass} rounded-lg`}></div>
                    <div className={`h-4 w-full ${skeletonClass} rounded-lg`}></div>
                </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default MediaCardSkeleton;

