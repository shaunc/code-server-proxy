FROM lscr.io/linuxserver/code-server:latest

# Override base image's DBUS_SESSION_BUS_ADDRESS to use session bus instead of system bus
ENV DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus

# Set ENV for POSIX shells to source .shrc (used for tool environments like CUDA)
ENV ENV=/config/.shrc

# Install gnome-keyring and dependencies for VSCode extension secrets
RUN apt-get update && apt-get install -y \
    gnome-keyring \
    libsecret-1-0 \
    libsecret-tools \
    dbus-x11 \
    jq \
    openssh-client \
    && rm -rf /var/lib/apt/lists/*

# Add NVIDIA CUDA detection for verification (optional)
# The NVIDIA Container Toolkit adds GPU devices at runtime
RUN if command -v nvidia-smi >/dev/null 2>&1; then \
      echo "NVIDIA GPU detected in container"; \
      nvidia-smi; \
    else \
      echo "No NVIDIA GPU detected (runtime will add if configured)"; \
    fi

# Configure SSH client for auto-SSH to host
# Use /config/.ssh/known_hosts which is populated at container startup by 93-setup-auto-ssh
# ControlMaster enables connection multiplexing - first connection persists, subsequent reuse it
RUN mkdir -p /etc/ssh && \
    echo "Host host.docker.internal" >> /etc/ssh/ssh_config && \
    echo "    StrictHostKeyChecking no" >> /etc/ssh/ssh_config && \
    echo "    UserKnownHostsFile /config/.ssh/known_hosts" >> /etc/ssh/ssh_config && \
    echo "    ServerAliveInterval 60" >> /etc/ssh/ssh_config && \
    echo "    ServerAliveCountMax 3" >> /etc/ssh/ssh_config && \
    echo "    ControlMaster auto" >> /etc/ssh/ssh_config && \
    echo "    ControlPath /run/user/1001/ssh-control-%h" >> /etc/ssh/ssh_config && \
    echo "    ControlPersist 600" >> /etc/ssh/ssh_config

# Copy git credential helper for keyring
COPY root/usr/local/bin/git-credential-keyring /usr/local/bin/git-credential-keyring
RUN chmod +x /usr/local/bin/git-credential-keyring

# Copy Claude Code wrapper for kilo-code integration
COPY root/usr/local/bin/claude-wrapper /usr/local/bin/claude
RUN chmod +x /usr/local/bin/claude

# Copy host-bash wrapper - forwards shell commands to host via SSH
# Used as SHELL for Kilo Code to execute commands on host instead of container
COPY root/usr/local/bin/host-bash /usr/local/bin/host-bash
RUN chmod +x /usr/local/bin/host-bash

# Set SHELL to host-bash for processes that respect $SHELL
ENV SHELL=/usr/local/bin/host-bash

# Replace /bin/sh with wrapper that forwards commands to host via SSH
# Kilo Code uses /bin/sh -c "command" to execute commands
# Backup original dash, install wrapper as /bin/sh
COPY root/bin/sh-host-wrapper /bin/sh-host-wrapper
RUN cp /bin/dash /bin/dash.real \
    && mv /bin/sh-host-wrapper /bin/sh \
    && chmod +x /bin/sh

# Create directory structure for initialization
RUN mkdir -p /etc/cont-init.d

# Copy s6-rc service definitions for dbus and keyring
# svc-dbus waits for abc UID to be set to PUID before starting
# This prevents D-Bus from running with wrong UID (911 vs 1001)
# Copy each file explicitly to avoid Docker caching issues with directory COPY
RUN mkdir -p /etc/s6-overlay/s6-rc.d/svc-dbus /etc/s6-overlay/s6-rc.d/svc-keyring
COPY root/etc/s6-overlay/s6-rc.d/svc-dbus/run /etc/s6-overlay/s6-rc.d/svc-dbus/run
COPY root/etc/s6-overlay/s6-rc.d/svc-dbus/type /etc/s6-overlay/s6-rc.d/svc-dbus/type
COPY root/etc/s6-overlay/s6-rc.d/svc-keyring/run /etc/s6-overlay/s6-rc.d/svc-keyring/run
COPY root/etc/s6-overlay/s6-rc.d/svc-keyring/type /etc/s6-overlay/s6-rc.d/svc-keyring/type
COPY root/etc/s6-overlay/s6-rc.d/user/contents.d/svc-dbus /etc/s6-overlay/s6-rc.d/user/contents.d/svc-dbus
COPY root/etc/s6-overlay/s6-rc.d/user/contents.d/svc-keyring /etc/s6-overlay/s6-rc.d/user/contents.d/svc-keyring
RUN chmod +x /etc/s6-overlay/s6-rc.d/svc-dbus/run \
    && chmod +x /etc/s6-overlay/s6-rc.d/svc-keyring/run \
    && echo "=== Verifying svc-dbus/run content ===" \
    && head -20 /etc/s6-overlay/s6-rc.d/svc-dbus/run \
    && echo "=== End verification ==="

# Copy initialization scripts (90+ to run after base image permission setup)
# Note: We don't manually start services - s6-overlay auto-starts /etc/services.d/ after init
COPY root/etc/cont-init.d/91-gnome-keyring /etc/cont-init.d/91-gnome-keyring
COPY root/etc/cont-init.d/92-sync-secrets /etc/cont-init.d/92-sync-secrets
COPY root/etc/cont-init.d/93-setup-auto-ssh /etc/cont-init.d/93-setup-auto-ssh
COPY root/etc/cont-init.d/94-sync-host-keyring /etc/cont-init.d/94-sync-host-keyring
COPY root/etc/cont-init.d/95-sync-gitconfig /etc/cont-init.d/95-sync-gitconfig
COPY root/etc/cont-init.d/96-setup-kilocode /etc/cont-init.d/96-setup-kilocode
RUN chmod +x /etc/cont-init.d/91-gnome-keyring \
    && chmod +x /etc/cont-init.d/92-sync-secrets \
    && chmod +x /etc/cont-init.d/93-setup-auto-ssh \
    && chmod +x /etc/cont-init.d/94-sync-host-keyring \
    && chmod +x /etc/cont-init.d/95-sync-gitconfig \
    && chmod +x /etc/cont-init.d/96-setup-kilocode

# Set SSH agent socket path (host agent is mounted to this location)
ENV SSH_AUTH_SOCK=/ssh-agent/socket

# Set D-Bus and GNOME Keyring environment variables
ENV DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus
ENV GNOME_KEYRING_CONTROL=/config/.cache/keyring-control

# Create symlink for node (bundled with code-server) so extensions like Pyright can find it
RUN ln -sf /app/code-server/lib/node /usr/local/bin/node

# Expose code-server port
EXPOSE 8443