# SEO + Google Search Console для hikkoGPT

Основной домен для SEO: `https://hikkogptsecret.vercel.app`

## 1. Верификация Google Search Console

- Вставить в `<head>` файла `index.html` тег:
  `<meta name="google-site-verification" content="ZgXpasM_jk83O1pW0m51vPkBCafYJdNNBW2ni1XekIY" />`
- Тег остаётся в коде навсегда — после деплоя на Vercel нажимаете «Verify» в Search Console.
- После верификации можно подключить Search Console как коннектор и отправить sitemap; это отдельный шаг после успешной верификации.

## 2. Мета-теги и соцпревью (`index.html`)

- Title: «hikkoGPT — бесплатный ИИ-чат с Gemini на русском» (до 60 символов).
- Description с ключевыми словами: ИИ-чат, нейросеть онлайн, Gemini, глубокий поиск, голосовой ввод (до 160 символов).
- `<html lang="ru">`, canonical `https://hikkogptsecret.vercel.app/`.
- Open Graph: og:title, og:description, og:url, og:type, og:site_name, og:locale=ru_RU; существующая og:image сохраняется.
- Twitter card: summary_large_image, title/description/image.
- Убрать дубли и устаревший `meta name="author"` / TODO-комментарии.

## 3. JSON-LD разметка

В `index.html` два блока structured data:
- `WebSite` — название, url, описание, inLanguage ru.
- `SoftwareApplication` — категория «Утилиты/ИИ», operatingSystem «Web», бесплатный доступ (`offers` с price 0).

Никаких выдуманных рейтингов и отзывов.

## 4. robots.txt + sitemap.xml

- В существующий `public/robots.txt` добавить директиву `Sitemap: https://hikkogptsecret.vercel.app/sitemap.xml`, блоки User-agent оставить как есть.
- Создать генератор `scripts/generate-sitemap.ts`, который пишет `public/sitemap.xml` c публичными маршрутами `/` и `/auth`, и подключить его через `predev`/`prebuild` в `package.json`. Без `lastmod` (нет достоверной даты изменения страницы).

## 5. Публичная лендинг-страница

Сейчас `/` для неавторизованного пользователя редиректит на `/auth`, поэтому поисковики не видят никакого контента — это главная SEO-проблема.

- Новый компонент `src/pages/Landing.tsx`: семантическая вёрстка (один `<h1>`, `<section>`, `<h2>`), в стиле текущей тёмной темы и с существующими анимациями/`btn-interactive`.
- Содержание (только реальные возможности приложения): что такое hikkoGPT, модели (HikkoGPT, Smart, Turbo, Спорящий, персонажи), глубокий поиск с источниками, автопоиск изображений, голосовой ввод, озвучка ответов, история чатов, тёмная/светлая тема.
- Секция FAQ-текстом (без FAQPage-разметки), CTA-кнопки «Начать бесплатно» → `/auth`.
- В `src/App.tsx`: маршрут `/` для неавторизованных рендерит `Landing` вместо `Navigate to="/auth"`; авторизованные по-прежнему видят чат. `/auth` не меняется.
- Изображения с `alt`, `loading="lazy"`.

## Технические заметки

- Стек — статический Vite SPA без SSR: краулеры читают только статический `<head>` из `index.html`, поэтому per-route мета-теги не добавляем — одного набора на приложение достаточно.
- Логика чата, авторизации и edge-функций не меняется.
- Изменения затрагивают: `index.html`, `public/robots.txt`, `scripts/generate-sitemap.ts` (новый), `package.json`, `src/pages/Landing.tsx` (новый), `src/App.tsx`.
