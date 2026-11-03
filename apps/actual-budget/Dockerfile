# Actual Budget 26.11.0.
FROM ghcr.io/actualbudget/actual@sha256:06cf186569cf58d93e12659ff1a517b65b5b0ebee7050a3991d4bd8a1d398da6

# The web client asks GitHub for Actual's latest release and fetches a news feed of release highlights
# from GitHub, but owners get new versions through MOS. Every line must match, or the build stops.
RUN cd /app/node_modules/@actual-app/web/build \
 && default=$(grep -rl --include='*.js' 'notifyWhenUpdateIsAvailable:notifyWhenUpdateIsAvailable===void 0||notifyWhenUpdateIsAvailable' .) \
 && check=$(grep -rl --include='*.js' 'if(globalPrefs&&globalPrefs.notifyWhenUpdateIsAvailable)' .) \
 && newsDefault=$(grep -rlF --include='*.js' 'showNewsFeed:showNewsFeed===void 0||showNewsFeed' .) \
 && newsFeed=$(grep -rlF --include='*.js' '[showNewsFeed]=useGlobalPref(`showNewsFeed`),isEnabled=!!showNewsFeed' .) \
 && [ -n "$default" ] && [ -n "$check" ] && [ -n "$newsDefault" ] && [ -n "$newsFeed" ] \
 && sed -i 's/notifyWhenUpdateIsAvailable:notifyWhenUpdateIsAvailable===void 0||notifyWhenUpdateIsAvailable/notifyWhenUpdateIsAvailable:!1/' $default \
 && sed -i 's/if(globalPrefs&&globalPrefs.notifyWhenUpdateIsAvailable)/if(!1)/' $check \
 && sed -i 's/showNewsFeed:showNewsFeed===void 0||showNewsFeed/showNewsFeed:!1/' $newsDefault \
 && sed -i 's/,isEnabled=!!showNewsFeed,/,isEnabled=!1,/' $newsFeed \
 && ! grep -rqF --include='*.js' 'isEnabled=!!showNewsFeed' .
