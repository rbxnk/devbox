FROM debian:trixie-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      openssh-server mosh iptables locales ca-certificates curl git build-essential \
      less procps ripgrep unzip \
      python3 python3-venv python3-pip python-is-python3 \
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

# Go, Node, uv and flyctl, updated by rebuilding. A mise-installed version, if any, comes first on PATH.
# Go: the latest release.
RUN v=$(curl -fsSL 'https://go.dev/VERSION?m=text' | head -1) \
 && curl -fsSL "https://go.dev/dl/$v.linux-$(dpkg --print-architecture).tar.gz" -o /tmp/go.tgz \
 && tar -C /usr/local -xzf /tmp/go.tgz && rm /tmp/go.tgz \
 && /usr/local/go/bin/go version \
 && echo 'export PATH="$PATH:/usr/local/go/bin:$HOME/go/bin"' > /etc/profile.d/go.sh
# Node: the current LTS, with npm; global installs go to ~/.local since dev has no root.
RUN curl -fsSL https://deb.nodesource.com/setup_lts.x -o /tmp/nodesource.sh && bash /tmp/nodesource.sh \
 && apt-get install -y --no-install-recommends nodejs && rm -rf /var/lib/apt/lists/* /tmp/nodesource.sh \
 && node --version && npm --version \
 && npm config set --location=global prefix '${HOME}/.local'
# uv, for Python tools and projects (pip outside a venv is blocked on Debian).
RUN curl -fsSL https://astral.sh/uv/install.sh -o /tmp/uv.sh \
 && UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh /tmp/uv.sh && rm /tmp/uv.sh \
 && uv --version
# flyctl, as fly and flyctl.
RUN curl -fsSL https://fly.io/install.sh -o /tmp/fly.sh && FLYCTL_INSTALL=/usr/local sh /tmp/fly.sh && rm /tmp/fly.sh \
 && fly version

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
