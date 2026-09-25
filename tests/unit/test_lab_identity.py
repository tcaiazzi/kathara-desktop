"""A lab's identity: its id is Kathara's hash of its directory's absolute path.

That one value is the registry key, the URL segment and the ``lab_hash`` every facade call is made
with (see ``lab_store.lab_id_for``). These tests pin what follows from it: the CLI and this app
agree on which containers belong to a lab, and nothing about identity depends on a lab's name.
"""

from Kathara.parser.netkit.LabParser import LabParser

from kathara_api.schemas.lab import LabCreate
from kathara_api.schemas.machine import MachineCreate
from kathara_api.services.lab_store import LabStore, lab_id_for
from tests.helpers import make_lab, make_service

LAB_CONF = 'pc1[image]="kathara/base"\npc1[0]="A"\n'


def test_a_labs_id_is_the_hash_kathara_lstart_gives_the_same_directory(tmp_path):
    """`kathara lstart` parses a lab with `LabParser.parse`, which hashes the directory's path —
    so a lab started from the CLI in this directory and the one this app deploys are the same
    lab, down to the `lab_hash` label on their containers."""
    service = make_service(LabStore(tmp_path / "labs"))
    lab, _ = make_lab(service, "demo", {"lab.conf": LAB_CONF})

    cli_lab = LabParser.parse(str(service.store.lab_dir("demo")))

    assert lab.hash == cli_lab.hash
    assert service.registry.get(cli_lab.hash) is lab


def test_a_lab_this_app_creates_hashes_the_same_for_the_cli(tmp_path):
    """The lab.conf this app generates carries no LAB_NAME, which LabParser would otherwise hash
    in place of the directory."""
    service = make_service(LabStore(tmp_path / "labs"))
    lab = service.create_lab(LabCreate(name="fresh", machines=[MachineCreate(name="pc1")]))

    assert LabParser.parse(str(service.store.lab_dir("fresh"))).hash == lab.hash


def test_labs_whose_directories_share_a_name_have_different_ids(tmp_path):
    first = LabStore(tmp_path / "one")
    second = LabStore(tmp_path / "two")

    assert lab_id_for(first.lab_dir("demo")) != lab_id_for(second.lab_dir("demo"))


def test_a_directory_reached_through_a_symlink_has_the_id_of_its_real_path(tmp_path):
    """Resolved the way Kathara resolves it (`utils.get_absolute_path`), so the same directory
    never has two ids depending on how it was reached."""
    real = tmp_path / "real"
    (real / "demo").mkdir(parents=True)
    link = tmp_path / "link"
    link.symlink_to(real, target_is_directory=True)

    assert lab_id_for(link / "demo") == lab_id_for(real / "demo")


def test_a_lab_keeps_its_directory_name_as_its_name(tmp_path):
    service = make_service(LabStore(tmp_path / "labs"))
    lab, _ = make_lab(service, "demo", {"lab.conf": LAB_CONF})

    assert lab.name == "demo"
    assert lab.hash == lab_id_for(service.store.lab_dir("demo"))


def test_a_directory_dropped_under_the_root_loads_whatever_its_name(tmp_path):
    """A name only has to be a valid *new* lab name when this app creates the directory; one that
    is already there is a lab like any other, addressed by the id of its path."""
    store = LabStore(tmp_path / "labs")
    (store.root / "My Lab").mkdir(parents=True)
    (store.root / "My Lab" / "lab.conf").write_text(LAB_CONF)

    service = make_service(store)
    lab = service.get_lab_or_reconstruct(lab_id_for(store.root / "My Lab"))

    assert lab.name == "My Lab"
    assert sorted(lab.machines) == ["pc1"]


def test_a_lab_whose_lab_conf_does_not_parse_can_still_be_read_and_deleted_by_id(tmp_path):
    """It never makes it into the registry, but it is still a directory under the root: its id
    resolves to it, so the file can be read and the lab removed like any other."""
    store = LabStore(tmp_path / "labs")
    broken = store.root / "broken"
    broken.mkdir(parents=True)
    (broken / "lab.conf").write_text("pc1[0]=A\npc1[2]=B\n")  # an interface gap: never loads
    service = make_service(store)
    broken_id = lab_id_for(broken)
    assert service.registry.get(broken_id) is None

    assert service.read_lab_conf(broken_id).content == "pc1[0]=A\npc1[2]=B\n"

    service.delete_lab(broken_id)

    assert not broken.exists()
