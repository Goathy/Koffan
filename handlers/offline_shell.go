package handlers

import (
	"shopping-list/db"
	"shopping-list/i18n"

	"github.com/gofiber/fiber/v2"
)

// GetOfflineListShell provides the cached UI for newly created offline lists.
// The local model selects the actual list from the URL, never from this shell.
func GetOfflineListShell(c *fiber.Ctx) error {
	snapshot, err := db.GetOfflineSnapshot()
	if err != nil {
		return sendError(c, 500, "error.fetch_failed")
	}
	return c.Render("list", fiber.Map{
		"List": &db.List{ShowCompleted: true}, "Lists": snapshot.Lists,
		"Sections": []db.Section{}, "Stats": db.Stats{}, "ShowCompleted": true,
		"OfflineSnapshot": snapshot, "Translations": i18n.GetAllLocales(),
		"Locales": i18n.AvailableLocales(), "DefaultLang": i18n.GetDefaultLang(),
	})
}
