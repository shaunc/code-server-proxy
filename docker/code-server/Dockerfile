FROM lscr.io/linuxserver/code-server:latest

# Set ENV for POSIX shells to source .shrc (used for tool environments like CUDA)
ENV ENV=/config/.shrc

# Install minimal dependencies (gnome-keyring removed - using pass on host)
RUN apt-get update && apt-get install -y \
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

# Copy initialization scripts (90+ to run after base image permission setup)
# Note: gnome-keyring scripts (91, 92, 94) removed - using pass on host
COPY root/etc/cont-init.d/93-setup-auto-ssh /etc/cont-init.d/93-setup-auto-ssh
COPY root/etc/cont-init.d/95-sync-gitconfig /etc/cont-init.d/95-sync-gitconfig
COPY root/etc/cont-init.d/96-setup-kilocode /etc/cont-init.d/96-setup-kilocode
RUN chmod +x /etc/cont-init.d/93-setup-auto-ssh \
    && chmod +x /etc/cont-init.d/95-sync-gitconfig \
    && chmod +x /etc/cont-init.d/96-setup-kilocode

# Set SSH agent socket path (host agent is mounted to this location)
ENV SSH_AUTH_SOCK=/ssh-agent/socket

# Create symlink for node (bundled with code-server) so extensions like Pyright can find it
RUN ln -sf /app/code-server/lib/node /usr/local/bin/node

# Install 'code' command for opening files in the running code-server instance
COPY root/usr/local/bin/code /usr/local/bin/code
RUN chmod +x /usr/local/bin/code

# Add /config/bin to PATH for user scripts (restart-container, etc.)
RUN echo '' >> /etc/bash.bashrc && \
    echo '# Add /config/bin to PATH for user scripts' >> /etc/bash.bashrc && \
    echo 'export PATH="/config/bin:$PATH"' >> /etc/bash.bashrc

# Fix user shell for VSCode environment resolution
# The linuxserver base image sets shell to /bin/false which causes
# "Unable to resolve your shell environment" errors (exit code 127)
RUN sed -i 's|/config:/bin/false|/config:/bin/bash|' /etc/passwd

# Expose code-server port
EXPOSE 8443