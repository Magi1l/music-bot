export const bandCampSearch = async (player, query, requestUser) => {
    let error = null;
    let tracks = [];
    if (player.LavalinkManager.options.advancedOptions.debugOptions.logCustomSearches)
        console.log(`Lavalink-Client-Debug | SEARCHING | - ${query} on lavalink-client`);
    player.LavalinkManager.utils.validateQueryString(player.node, query);
    try {
        const requestUrl = new URL("https://bandcamp.com/api/nusearch/2/autocomplete");
        requestUrl.searchParams.append("q", query);
        const data = await fetch(requestUrl.toString(), {
            headers: {
                'User-Agent': 'android-async-http/1.4.1 (http://loopj.com/android-async-http)',
                'Cookie': '$Version=1'
            }
        });
        const json = await data.json();
        tracks = json?.results?.filter(x => !!x && typeof x === "object" && "type" in x && x.type === "t").map?.(item => player.LavalinkManager.utils.buildUnresolvedTrack({
            uri: item.url || item.uri,
            artworkUrl: item.img,
            author: item.band_name,
            title: item.name,
            identifier: item.id ? `${item.id}` : item.url?.split("/").reverse()[0],
        }, requestUser));
    }
    catch (e) {
        error = e;
    }
    return {
        loadType: "search",
        exception: error,
        pluginInfo: {},
        playlist: null,
        tracks: tracks
    };
};
