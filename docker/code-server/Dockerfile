FROM lscr.io/linuxserver/code-server:latest

# Install gnome-keyring and dependencies for VSCode extension secrets
RUN apt-get update && apt-get install -y \
    gnome-keyring \
    libsecret-1-0 \
    libsecret-tools \
    dbus-x11 \
    jq \
    && rm -rf /var/lib/apt/lists/*

# Create directory structure for gnome-keyring service and initialization
RUN mkdir -p /etc/services.d/gnome-keyring \
    && mkdir -p /etc/cont-init.d

# Copy gnome-keyring service script
COPY root/etc/services.d/gnome-keyring/run /etc/services.d/gnome-keyring/run
RUN chmod +x /etc/services.d/gnome-keyring/run

# Copy initialization scripts
COPY root/etc/cont-init.d/50-gnome-keyring /etc/cont-init.d/50-gnome-keyring
COPY root/etc/cont-init.d/51-sync-secrets /etc/cont-init.d/51-sync-secrets
RUN chmod +x /etc/cont-init.d/50-gnome-keyring \
    && chmod +x /etc/cont-init.d/51-sync-secrets

# Expose code-server port
EXPOSE 8443