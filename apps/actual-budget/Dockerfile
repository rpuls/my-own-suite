# Actual Budget 26.8.1.
FROM ghcr.io/actualbudget/actual@sha256:6478d9ddfc0924479c09e6699c205e354c6f2216dfe7de3c0fb7b590d6edcdc5

# The web client asks GitHub for Actual's latest release and announces it, but owners get
# new versions through MOS. Both lines must match, or the build stops rather than ship the check.
RUN cd /app/node_modules/@actual-app/web/build \
 && default=$(grep -rl --include='*.js' 'notifyWhenUpdateIsAvailable:notifyWhenUpdateIsAvailable===void 0||notifyWhenUpdateIsAvailable' .) \
 && check=$(grep -rl --include='*.js' 'if(globalPrefs&&globalPrefs.notifyWhenUpdateIsAvailable)' .) \
 && [ -n "$default" ] && [ -n "$check" ] \
 && sed -i 's/notifyWhenUpdateIsAvailable:notifyWhenUpdateIsAvailable===void 0||notifyWhenUpdateIsAvailable/notifyWhenUpdateIsAvailable:!1/' $default \
 && sed -i 's/if(globalPrefs&&globalPrefs.notifyWhenUpdateIsAvailable)/if(!1)/' $check
