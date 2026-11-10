FROM debian:trixie-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      openssh-server mosh iptables locales ca-certificates curl git build-essential \
      less procps ripgrep unzip \
 && sed -i 's/^# *en_US.UTF-8/en_US.UTF-8/' /etc/locale.gen && locale-gen \
 && echo LANG=en_US.UTF-8 > /etc/default/locale \
 && echo 'export LANG=en_US.UTF-8' > /etc/profile.d/locale.sh \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /run/sshd /etc/ssh/keys /etc/ssh/authorized_keys \
 && rm -f /etc/ssh/ssh_host_*
ENV LANG=en_US.UTF-8

# GitHub CLI, from GitHub's own apt repository (Debian's lags behind).
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# mise for languages and CLIs. The binary is in the image (update it by rebuilding);
# the tools it installs live in dev's home folder. Shims on PATH also cover
# non-interactive shells, such as the commands agents run.
RUN curl -fsSL https://mise.run -o /tmp/mise.sh \
 && MISE_INSTALL_PATH=/usr/local/bin/mise sh /tmp/mise.sh && rm /tmp/mise.sh \
 && mise --version \
 && echo 'export PATH="$HOME/.local/share/mise/shims:$PATH"' > /etc/profile.d/mise.sh

# No password and no sudo: agents can't get root or undo anything set up as root.
# '*' rather than the default '!' so sshd doesn't treat the account as locked.
# DEV_UID/DEV_GID: the owner of the data folders on the host. The default is Unraid's nobody:users (99:100).
# uid 0 would make dev root, so it's refused.
ARG DEV_UID=99 DEV_GID=100
RUN [ "$DEV_UID" != 0 ] && groupadd -o -g "$DEV_GID" dev && useradd -o -m -u "$DEV_UID" -g dev -s /bin/bash dev && usermod -p '*' dev

COPY sshd.conf /etc/ssh/sshd_config.d/devbox.conf
COPY entrypoint.sh check.sh lanblock.sh /usr/local/bin/

EXPOSE 22 60000-60010/udp
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
