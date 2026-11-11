# WorldsHub для macOS

[English](README.md) · **Русский**

> [!NOTE]
> This is a completely vibe-coded and unofficial implementation of WorldHub for macOS. It is provided as is and has been done as a proof-of-concept (and also to help some people play).
>
> Это полностью «вайб-кодинг» и неофициальная реализация WorldHub для macOS. Предоставляется как есть, сделана как proof-of-concept (а также чтобы помочь некоторым людям поиграть).

Тонкая Electron-обёртка вокруг официального веб-клиента WorldsHub, у которой Windows-зависимая P2P-часть пересобрана для macOS. Позволяет **подключаться** к мирам Minecraft, которые хостят игроки с официальным Windows-клиентом. Создание миров не поддерживается.

Только Apple Silicon (arm64).

## 1. Установка и запуск

1. Скачайте `WorldsHub-macOS-arm64.zip` из [Releases](https://github.com/vladyio/worldshub-macos/releases/latest) и распакуйте.
2. Перетащите `WorldsHub.app` в `/Applications`.
3. Запустите приложение. При первом запуске macOS может его заблокировать — решения ниже.
4. Войдите в свой аккаунт WorldsHub.
5. Выберите мир, который хостит игрок с официальным Windows-клиентом, и нажмите **Connect**.
6. Если macOS спросит доступ к локальной сети — разрешите.
7. В Minecraft Java Edition: **Сетевая игра → Прямое подключение → `localhost:25565`**.

### 1.1 Проблемы и ошибки

- **«WorldsHub.app повреждён» или «Apple не может проверить приложение»** — сборка подписана ad-hoc, без нотаризации. Нажмите правой кнопкой по приложению → **Открыть** → **Открыть**. Если не помогло, выполните:
  `xattr -dr com.apple.quarantine /Applications/WorldsHub.app`
  или используйте **Системные настройки → Конфиденциальность и безопасность → Всё равно открыть**.
- **Не подключается к `localhost:25565`** — порт должен быть свободен. Остановите локальный сервер Minecraft на порту 25565 и переподключитесь в приложении.
- **«Invalid or expired authorization token»** — выйдите из аккаунта WorldsHub и войдите снова.
- **Нет миров / хост недоступен** — хост должен быть онлайн в официальном Windows-клиенте WorldsHub.
- **Доступ к локальной сети запрещён** — включите его в **Системные настройки → Конфиденциальность и безопасность → Локальная сеть**. Без этого прямое подключение может не работать (TURN-релей иногда спасает).
- **Только подключение** — создание миров на macOS намеренно отключено.
- **Нет сборки для Intel** — этот релиз только для arm64.

## 2. Структура приложения и схема работы

```
main.js                             главный процесс Electron: окно, IPC-мост, версия приложения
preload.js                          contextBridge -> window.electron (sendToProcess/onEvent/invoke)
client.js                           логика клиента WorldsHub: signaling, WebRTC, локальный прокси
config.js                           адрес signaling-сервера, ICE-серверы, 127.0.0.1:25565
minecraft-datachannel-parser.js     парсер пакетов Minecraft для login/status
main-process/utils/turn-servers.js  получение TURN-данных с бэкенда WorldsHub
```

UI не входит в сборку. `main.js` загружает `https://app.worldshub.io` — так же, как официальное приложение, — и через `preload.js` предоставляет тот же IPC-интерфейс. Сайт отвечает за логин, список миров и интерфейс; Electron занимается только P2P-подключением.

Схема подключения:

1. Веб-интерфейс вызывает `window.electron.sendToProcess('connect-to-host', { serverId, token, ... })`.
2. `main.js` передаёт вызов в `client.connectToHost(...)`.
3. `client.js` открывает Socket.IO-соединение с `app.worldshub.io` и регистрируется как клиент с JWT пользователя.
4. После `client_authorized` создаётся WebRTC peer connection (`node-datachannel`), а offer, answer и ICE-кандидаты проходят через signaling-сервер.
5. TCP-прокси на `127.0.0.1:25565` передаёт трафик Minecraft через WebRTC data channel хосту.
6. Логи, статусы и уведомления возвращаются в UI сообщениями `ui-event`.

Windows-хост выполняет тот же протокол в обратную сторону и перенаправляет трафик на свой локальный сервер Minecraft.

### Сборка из исходников

Нужны macOS arm64 и Node.js.

```bash
npm install
npm start          # запуск для разработки
npm run build      # -> dist/mac-arm64/WorldsHub.app
codesign --force --deep --sign - dist/mac-arm64/WorldsHub.app
```

Если npm блокирует install-скрипты: `npm install-scripts approve electron node-datachannel && npm rebuild`.

## Лицензия

Общественное достояние — см. [LICENSE](LICENSE).
