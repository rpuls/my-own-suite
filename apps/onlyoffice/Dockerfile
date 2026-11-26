FROM onlyoffice/documentserver@sha256:53a06109f1f4029a78f913a061e14f01bff023d109024073a13d4416b54d2195

# Platform compatibility wrapper:
# - Supports binding nginx to platform-provided PORT.
# - Normalizes env values that may be wrapped in platform UIs.
COPY entrypoint.sh /opt/onlyoffice/entrypoint.sh
RUN sed -i 's/\r$//' /opt/onlyoffice/entrypoint.sh && chmod +x /opt/onlyoffice/entrypoint.sh

# The welcome page links its font from Google Fonts, which would tell Google about every
# visit; without the link it uses the system font.
RUN sed -i '/fonts.googleapis.com/d' /var/www/onlyoffice/documentserver-example/welcome/*.html

# ONLYOFFICE's AI plugin 3.0.8, the release current at 9.3.1: 3.2.2 expects settings
# version 4 and ignores this server's 3. The entrypoint puts it in place only while the
# owner has given ONLYOFFICE an AI service.
ADD https://raw.githubusercontent.com/ONLYOFFICE/onlyoffice.github.io/689547aa716cf83c5696253852373f3d12d19d9d/sdkjs-plugins/content/ai/deploy/ai.plugin /opt/onlyoffice/ai.plugin
RUN echo "80712e63511b48524cb8ae3783cc31fd3ef21b7fa4e76723d5438a365f00ea5f  /opt/onlyoffice/ai.plugin" | sha256sum -c - \
 && unzip -q /opt/onlyoffice/ai.plugin -d /opt/onlyoffice/ai-plugin \
 && rm /opt/onlyoffice/ai.plugin

ENTRYPOINT ["/opt/onlyoffice/entrypoint.sh"]
