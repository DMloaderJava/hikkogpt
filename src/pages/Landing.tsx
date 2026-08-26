import { Link } from "react-router-dom";
import {
  MessageSquare, Search, Image as ImageIcon, Mic, Volume2,
  History, Moon, Sparkles, ArrowRight,
} from "lucide-react";

const features = [
  { icon: MessageSquare, title: "Несколько моделей ИИ", text: "HikkoGPT, Smart, Turbo и «Спорящий» — выбирайте модель под задачу: от быстрых ответов до глубоких размышлений." },
  { icon: Search, title: "Глубокий поиск", text: "Нейросеть уточняет задачу, ищет информацию в интернете и собирает структурированный отчёт со списком источников." },
  { icon: ImageIcon, title: "Поиск изображений", text: "Когда изображения помогают ответу, ИИ сам находит их и прикрепляет к сообщению." },
  { icon: Mic, title: "Голосовой ввод", text: "Диктуйте запрос голосом — речь автоматически превращается в текст." },
  { icon: Volume2, title: "Озвучка ответов", text: "Любой ответ можно прослушать: доступно несколько голосов на выбор." },
  { icon: History, title: "История чатов", text: "Все диалоги сохраняются в вашем аккаунте, их можно переименовать или удалить." },
  { icon: Moon, title: "Тёмная и светлая тема", text: "Интерфейс адаптирован под телефон и компьютер, тема переключается одним нажатием." },
  { icon: Sparkles, title: "Персонажи", text: "Общайтесь в характерных стилях — например, «Илон Маск» или «Прохожий0»." },
];

const faq = [
  { q: "hikkoGPT бесплатный?", a: "Да, чат доступен бесплатно после регистрации аккаунта." },
  { q: "На какой модели работает hikkoGPT?", a: "В основе — модели семейства Google Gemini; в селекторе можно выбрать более быструю или более «думающую» модель." },
  { q: "Понимает ли нейросеть русский язык?", a: "Да, hikkoGPT свободно общается на русском: и в тексте, и в голосовом вводе, и в озвучке ответов." },
  { q: "Нужна ли регистрация?", a: "Да, аккаунт нужен, чтобы сохранять историю чатов и синхронизировать её между устройствами." },
];

const Landing = () => {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4 animate-fade-in">
        <span className="text-lg font-semibold">hikkoGPT</span>
        <Link
          to="/auth"
          className="btn-interactive rounded-lg border border-border px-4 py-2 text-sm transition-all"
        >
          Войти
        </Link>
      </header>

      <main>
        <section className="mx-auto max-w-3xl px-4 pb-16 pt-10 text-center sm:pt-20">
          <h1 className="animate-fade-in text-3xl font-bold leading-tight sm:text-5xl">
            hikkoGPT — бесплатный ИИ-чат с Gemini на русском
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-base text-muted-foreground sm:text-lg">
            Задавайте вопросы, ищите информацию в интернете с источниками, слушайте ответы голосом
            и получайте подходящие изображения — всё в одном чате с нейросетью.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link
              to="/auth"
              className="btn-interactive inline-flex items-center gap-2 rounded-xl bg-primary px-6 py-3 text-sm font-medium text-primary-foreground transition-all"
            >
              Начать бесплатно <ArrowRight className="h-4 w-4" />
            </Link>
            <a
              href="#features"
              className="btn-interactive rounded-xl border border-border px-6 py-3 text-sm transition-all"
            >
              Возможности
            </a>
          </div>
        </section>

        <section id="features" className="mx-auto max-w-5xl px-4 pb-16">
          <h2 className="text-center text-2xl font-semibold sm:text-3xl">Что умеет hikkoGPT</h2>
          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {features.map(({ icon: Icon, title, text }) => (
              <article
                key={title}
                className="animate-scale-in rounded-2xl border border-border bg-card p-5 transition-all hover:border-interactive/50"
              >
                <Icon className="h-5 w-5 text-interactive" aria-hidden="true" />
                <h3 className="mt-3 text-base font-medium">{title}</h3>
                <p className="mt-2 text-sm text-muted-foreground">{text}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="mx-auto max-w-3xl px-4 pb-16">
          <h2 className="text-2xl font-semibold sm:text-3xl">Как это работает</h2>
          <ol className="mt-6 space-y-4 text-sm text-muted-foreground sm:text-base">
            <li><strong className="text-foreground">1. Создайте аккаунт</strong> — по почте, за несколько секунд.</li>
            <li><strong className="text-foreground">2. Выберите модель</strong> — быструю для коротких вопросов или «думающую» для сложных задач.</li>
            <li><strong className="text-foreground">3. Задайте вопрос</strong> — текстом, голосом или с приложенным изображением.</li>
            <li><strong className="text-foreground">4. Включите глубокий поиск</strong>, если нужен разбор темы со ссылками на источники.</li>
          </ol>
        </section>

        <section className="mx-auto max-w-3xl px-4 pb-20">
          <h2 className="text-2xl font-semibold sm:text-3xl">Частые вопросы</h2>
          <div className="mt-6 space-y-5">
            {faq.map(({ q, a }) => (
              <div key={q}>
                <h3 className="text-base font-medium">{q}</h3>
                <p className="mt-1 text-sm text-muted-foreground">{a}</p>
              </div>
            ))}
          </div>
        </section>
      </main>

      <footer className="border-t border-border py-8 text-center text-sm text-muted-foreground">
        <p>hikkoGPT — ИИ-чат на базе Gemini.</p>
        <Link to="/auth" className="mt-2 inline-block text-interactive hover:underline">
          Открыть чат
        </Link>
      </footer>
    </div>
  );
};

export default Landing;
