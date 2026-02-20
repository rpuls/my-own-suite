FROM onlyoffice/documentserver:latest

# For fully automated first-run UX, enable the built-in example app and
# admin panel so /example and /admin do not return 502 after container start.
RUN sed -i "s/autostart=false/autostart=true/g" /etc/supervisor/conf.d/ds-example.conf \
 && sed -i "s/autostart=false/autostart=true/g" /etc/supervisor/conf.d/ds-adminpanel.conf
